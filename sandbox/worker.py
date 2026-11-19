"""Instance-local command runner. The harness owns durable dispatch reservations."""
import hmac
import asyncio, os, json, hashlib, re, signal, time, socket, ipaddress, tempfile
from collections import OrderedDict
from uuid import uuid4

workspace=os.environ.get('WORKSPACE','/workspace'); guard=os.environ.get('GUARD','/opt/terminal/guard')
runtime_key=os.environ['RUNTIME_KEY']
if len(runtime_key)<32: raise ValueError('missing worker credential')
boot=str(uuid4()); calls=OrderedDict(); limit=16384
# SOCKS5 CONNECT on a Pod-local filesystem socket. Never resolve a validated name twice.
# IPv4-only by design (avoids IPv6 transition routes to non-public addresses).
egress_path=''; connections=0
async def egress(reader,writer):
    global connections
    if connections >= 16: writer.close(); return
    connections+=1;up=None;tasks=[]
    try:
        async with asyncio.timeout(30):
            read=reader.readexactly
            version,n=await read(2)
            if version!=5 or 0 not in await read(n):return
            writer.write(bytes([5,0]));await writer.drain()
            version,cmd,reserved,kind=await read(4)
            if (version,cmd,reserved)!=(5,1,0):return
            if kind==1: host=str(ipaddress.IPv4Address(await read(4)))
            elif kind==3: host=(await read((await read(1))[0])).decode('ascii').rstrip('.')
            else:return
            port=int.from_bytes(await read(2),'big');loop=asyncio.get_running_loop()
            if port not in (80,443) or '.' not in host or not re.fullmatch(r'[a-zA-Z0-9.-]+',host):raise ValueError()
            addresses=await loop.getaddrinfo(host+'.',port,family=socket.AF_INET,type=socket.SOCK_STREAM)
            ips=[ipaddress.IPv4Address(addr[4][0]) for addr in addresses]
            if not ips or any(not ip.is_global or ip.is_multicast for ip in ips):raise ValueError()
            remote,up=await asyncio.open_connection(str(ips[0]),port,family=socket.AF_INET,flags=socket.AI_NUMERICHOST)
            writer.write(bytes([5,0,0,1])+bytes(6));await writer.drain()
            async def pipe(src,dst):
                while block:=await src.read(32768):dst.write(block);await dst.drain()
            tasks=[asyncio.create_task(pipe(reader,up)),asyncio.create_task(pipe(remote,writer))];await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
    except (ValueError,OSError,TimeoutError,asyncio.IncompleteReadError):
        if up is None:writer.write(bytes([5,2,0,1])+bytes(6))
    finally:
        for t in tasks:t.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
        if up:up.close()
        writer.close();connections-=1
async def execute(entry, command):
    proc=None
    try:
        proc=await asyncio.create_subprocess_exec(guard,workspace,command,env={**({'ALL_PROXY':'socks5h://localhost'+egress_path,'all_proxy':'socks5h://localhost'+egress_path,'PI_EGRESS_SOCKET':egress_path} if egress_path else {}),'SSL_CERT_FILE':'/etc/ssl/certs/ca-certificates.crt','PATH':'/usr/local/bin:/usr/bin:/bin','HOME':workspace,'LANG':'C.UTF-8','TMPDIR':workspace+'/.tmp'},cwd=workspace,stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True)
        entry['pid']=proc.pid
        async def capture(stream, name):
            output=bytearray(); total=0
            while chunk:=await stream.read(8192):
                if total<4096: entry.setdefault('preview',{})[name]=(output+chunk)[:4096].decode(errors='replace')
                total+=len(chunk);output.extend(chunk[:max(0,limit-len(output))])
            return output.decode(errors='replace')+ ('\n[truncated]' if total>limit else '')
        readers=asyncio.gather(capture(proc.stdout,'stdout'),capture(proc.stderr,'stderr'));timed=False
        try: await asyncio.wait_for(asyncio.shield(proc.wait()),30)
        except TimeoutError: timed=True
        finally:
            try: os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError: pass
        out,err=await readers;code=await proc.wait();entry['result']=dict(stdout=out,stderr=err,exitCode=code,timedOut=timed)
    except Exception: entry['result']=dict(stdout='',stderr='command unavailable; outcome unknown',exitCode=126)
    finally: entry.pop('pid',None);entry.pop('preview',None);entry['state']='done'

def dispatch(path,data):
    if path=='/health': return 200,dict(boot=boot,active=sum(c['state']=='running' for c in calls.values()))
    ident=data.get('id',''); assert re.fullmatch('[0-9a-f]{64}',ident)
    e=calls.get(ident)
    if path=='/cmd':
        cmd=data['command'];assert isinstance(cmd,str) and 0<len(cmd)<=8192
        if data.get('boot')!=boot:return 409,{'state':'stale'}
        digest=hashlib.sha256(cmd.encode()).hexdigest()
        if e and e['digest']!=digest:return 409,{'state':'conflict'}
        if not e:
            if any(c['state']=='running' for c in calls.values()):return 409,{'state':'busy'}
            if len(calls)>=128:calls.popitem(last=False)
            e=calls[ident]=dict(digest=digest,state='running');e['task']=asyncio.create_task(execute(e,cmd))
    elif path=='/cancel' and e and e['state']=='running':
        if 'pid' in e:
            try:os.killpg(e['pid'],signal.SIGKILL)
            except ProcessLookupError:pass
        else:e['task'].cancel();e.update(state='done',result=dict(exitCode=130,stdout='',stderr='cancelled'))
    elif path not in ('/get','/cancel'):return 404,{}
    return 200, {k:v for k,v in (e or {'state':'missing'}).items() if k in ('state','result','preview')}
async def serve(reader,writer):
    try:
        async with asyncio.timeout(6):
            headers=(await reader.readuntil(b'\r\n\r\n')).decode('ascii').split('\r\n');method,path,_=headers[0].split();h={k.lower():v.strip() for k,v in (line.split(':',1) for line in headers[1:] if line)};size=int(h.get('content-length','0'));assert 0<=size<=65536
            assert method=='POST' or (method=='GET' and path=='/health')
            if not hmac.compare_digest(h.get('authorization',''),'Bearer '+runtime_key): status,data=403,{}
            else:
                body=await reader.readexactly(size);status,data=dispatch(path,json.loads(body or b'{}'))
    except Exception:status,data=400,{}
    b=json.dumps(data).encode();writer.write(f'HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {len(b)}\r\nConnection: close\r\n\r\n'.encode()+b);await writer.drain();writer.close()
async def main():
    os.makedirs(workspace+'/.tmp',exist_ok=True);p=await asyncio.create_subprocess_exec(guard,workspace,'true');assert await p.wait()==0,'guard unavailable'
    global egress_path
    if os.environ.get('EGRESS_WEB')=='1':
        directory=tempfile.mkdtemp(prefix='pi-egress-',dir=os.environ.get('PI_SOCKET_DIR'));egress_path=directory+'/out.sock'
        proxy=await asyncio.start_unix_server(egress,path=egress_path)
    s=await asyncio.start_server(serve,os.environ.get('BIND','0.0.0.0'),int(os.environ.get('PORT','8282')));print('ready',flush=True);await s.serve_forever()
if __name__=='__main__':asyncio.run(main())
