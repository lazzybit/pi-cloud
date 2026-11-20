package process

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const previewLimit = 4096
const resultLimit = 16384

type Output struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}
type Result struct {
	Output
	ExitCode int  `json:"exitCode"`
	TimedOut bool `json:"timedOut"`
}
type Stream struct {
	mu        sync.Mutex
	data      []byte
	truncated bool
}

func (s *Stream) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := min(len(p), resultLimit-len(s.data))
	s.data = append(s.data, p[:n]...)
	s.truncated = s.truncated || n < len(p)
	return len(p), nil
}
func (s *Stream) Preview() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.ToValidUTF8(string(s.data[:min(len(s.data), previewLimit)]), "�")
}
func (s *Stream) final() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := strings.ToValidUTF8(string(s.data), "�")
	if s.truncated {
		v += "\n[truncated]"
	}
	return v
}

type Runner struct {
	Guard, Workspace string
	Limit            time.Duration
}

func (r Runner) Check(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Join(r.Workspace, ".tmp"), 0700); err != nil {
		return err
	}
	if r.Run(ctx, "true", new(Stream), new(Stream)).ExitCode != 0 {
		return errors.New("guard self-check failed")
	}
	return nil
}
func (r Runner) Run(parent context.Context, command string, stdout, stderr *Stream) Result {
	unavailable := Result{Output: Output{Stderr: "command unavailable"}, ExitCode: 126}
	ctx, cancel := context.WithTimeout(parent, r.Limit)
	defer cancel()
	if ctx.Err() != nil {
		return Result{ExitCode: 130}
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		return unavailable
	}
	defer outR.Close()
	defer outW.Close()
	errR, errW, err := os.Pipe()
	if err != nil {
		return unavailable
	}
	defer errR.Close()
	defer errW.Close()
	cmd := exec.Command(r.Guard, r.Workspace, command)
	cmd.Dir = r.Workspace
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + r.Workspace, "LANG=C.UTF-8", "TMPDIR=" + filepath.Join(r.Workspace, ".tmp"), "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	cmd.Stdout, cmd.Stderr = outW, errW
	if err := cmd.Start(); err != nil {
		return unavailable
	}
	outW.Close()
	errW.Close()
	var pipes sync.WaitGroup
	pipes.Go(func() { _, _ = io.Copy(stdout, outR) })
	pipes.Go(func() { _, _ = io.Copy(stderr, errR) })
	leader := cmd.Process.Pid
	exited := make(chan error, 1)
	go func() {
		// Observe exit without reaping. The leader keeps its PID until group cleanup.
		for {
			err := unix.Waitid(unix.P_PID, leader, new(unix.Siginfo), unix.WEXITED|unix.WNOWAIT, nil)
			if err != unix.EINTR {
				exited <- err
				return
			}
		}
	}()
	var waitErr error
	var timedOut bool
	select {
	case waitErr = <-exited:
		_ = unix.Kill(-leader, unix.SIGKILL)
	case <-ctx.Done():
		timedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		_ = unix.Kill(-leader, unix.SIGKILL)
		waitErr = <-exited
	}
	err = cmd.Wait()
	if waitErr != nil {
		return unavailable
	}
	drained := make(chan struct{})
	go func() { pipes.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(time.Second):
		outR.Close()
		errR.Close()
		<-drained
	}
	code := cmd.ProcessState.ExitCode()
	if code < 0 {
		code = 130
	}
	if err != nil && code == 0 {
		code = 126
	}
	return Result{Output{stdout.final(), stderr.final()}, code, timedOut}
}
