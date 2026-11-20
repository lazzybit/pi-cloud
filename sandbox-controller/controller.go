package main

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strconv"
	"sync"
	"time"
)

type object struct {
	Metadata struct {
		Name, UID, ResourceVersion, DeletionTimestamp string
		Labels, Annotations                           map[string]string
	}
	Status struct {
		Phase, PodIP string
		Conditions   []struct{ Type, Status string }
	}
	Spec struct {
		Containers []struct {
			Env []struct{ Name, Value string }
		}
	}
	Items []object
}
type kube func(context.Context, string, string, any) (*object, error)
type controller struct {
	k     kube
	c     config
	idle  time.Duration
	locks [256]sync.Mutex
}

func (h *controller) lock(name string) func() {
	v, _ := strconv.ParseUint(name[3:5], 16, 8)
	l := &h.locks[v]
	l.Lock()
	return l.Unlock
}
func (h *controller) remove(ctx context.Context, p *object) error {
	_, e := h.k(ctx, "DELETE", "pods/"+p.Metadata.Name, M{"preconditions": M{"uid": p.Metadata.UID, "resourceVersion": p.Metadata.ResourceVersion}})
	return e
}
func (h *controller) act(ctx context.Context, r request) (M, error) {
	if !r.valid() {
		return nil, errors.New("invalid request")
	}
	name := "sb-" + r.Owner[:48]
	defer h.lock(name)()
	p, e := h.k(ctx, "GET", "pods/"+name, nil)
	if e != nil {
		return nil, e
	}
	a := map[string]string{}
	if p != nil {
		if p.Metadata.Labels[label] != managed || p.Metadata.Annotations["owner"] != r.Owner {
			return nil, errors.New("not owned")
		}
		a = p.Metadata.Annotations
	}
	now := time.Now().UnixMilli()
	ms := func(n int64) string { return strconv.FormatInt(n, 10) }
	mark := func(fields M) (M, error) {
		_, e := h.k(ctx, "PATCH", "pods/"+name, M{"metadata": M{"resourceVersion": p.Metadata.ResourceVersion, "annotations": fields}})
		return M{}, e
	}
	endpoint := func() (M, error) {
		if net.ParseIP(p.Status.PodIP) != nil && len(p.Spec.Containers) > 0 {
			for _, v := range p.Spec.Containers[0].Env {
				if v.Name == "RUNTIME_KEY" && v.Value != "" {
					return M{"url": "http://" + net.JoinHostPort(p.Status.PodIP, "8282"), "key": v.Value, "uid": p.Metadata.UID}, nil
				}
			}
		}
		return nil, errors.New("missing endpoint")
	}
	switch r.Action {
	case "fence":
		if p != nil && p.Metadata.DeletionTimestamp == "" {
			return M{}, h.remove(ctx, p)
		}
		return M{}, nil
	case "release":
		if p != nil && p.Metadata.UID == r.Uid && a["lease"] == r.Id {
			return mark(M{"activity": ms(now), "lease": nil, "until": nil})
		}
		return M{}, nil
	case "lookup":
		if p != nil && p.Metadata.UID == r.Uid && p.Metadata.DeletionTimestamp == "" {
			return endpoint()
		}
		return M{"missing": true}, nil
	}
	pending := M{"pending": true}
	if p != nil && p.Metadata.DeletionTimestamp != "" {
		return pending, nil
	}
	claim, uid := "", ""
	if *r.Grants.Volume {
		claim = "pv-" + r.Owner[:48]
		q, e := h.k(ctx, "GET", "persistentvolumeclaims/"+claim, nil)
		if e != nil {
			return nil, e
		}
		if q == nil {
			spec := M{"accessModes": []string{"ReadWriteOncePod"}, "resources": M{"requests": M{"storage": h.c.Size}}}
			if h.c.StorageClass != "" {
				spec["storageClassName"] = h.c.StorageClass
			}
			q, e = h.k(ctx, "POST", "persistentvolumeclaims", M{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": M{"name": claim, "labels": M{label: managed}, "annotations": M{"owner": r.Owner}}, "spec": spec})
			if e != nil {
				return nil, e
			}
		}
		if q.Metadata.Annotations["owner"] != r.Owner || q.Metadata.DeletionTimestamp != "" || q.Metadata.UID == "" {
			return nil, errors.New("invalid personal claim")
		}
		uid = q.Metadata.UID
	}
	b := binding(r, h.c, uid)
	if p != nil && (a["binding"] != b || p.Status.Phase == "Failed" || p.Status.Phase == "Succeeded") {
		return pending, h.remove(ctx, p)
	}
	ready := false
	if p != nil {
		for _, c := range p.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready = true
			}
		}
	}
	until, _ := strconv.ParseInt(a["until"], 10, 64)
	if r.Action == "check" {
		return M{"valid": ready && p.Metadata.UID == r.Uid && a["lease"] == r.Id && until > now}, nil
	}
	if p == nil {
		_, e = h.k(ctx, "POST", "pods", manifest(r, h.c, claim, b, now))
		return pending, e
	}
	if !ready {
		return pending, nil
	}
	if r.Action == "warm" {
		if a["lastWarm"] != r.Id {
			_, e = mark(M{"activity": ms(now), "lastWarm": r.Id})
		}
		return M{"ready": true}, e
	}
	if a["lease"] != "" && a["lease"] != r.Id && until > now {
		return pending, nil
	}
	if _, e = mark(M{"lease": r.Id, "until": ms(now + 90000)}); e != nil {
		return nil, e
	}
	return endpoint()
}
func (h *controller) sweep(ctx context.Context) error {
	ps, e := h.k(ctx, "GET", "pods?labelSelector="+url.QueryEscape(label+"="+managed), nil)
	if e != nil {
		return e
	}
	for _, p := range ps.Items {
		name := p.Metadata.Name
		if len(name) != 51 {
			continue
		}
		unlock := h.lock(name)
		current, e := h.k(ctx, "GET", "pods/"+name, nil)
		if e == nil && current != nil && current.Metadata.UID == p.Metadata.UID && current.Metadata.Labels[label] == managed && current.Metadata.DeletionTimestamp == "" {
			a := current.Metadata.Annotations
			last, e := strconv.ParseInt(a["activity"], 10, 64)
			until, _ := strconv.ParseInt(a["until"], 10, 64)
			if e == nil && time.Since(time.UnixMilli(max(last, until))) >= h.idle {
				e = h.remove(ctx, current)
				if e != nil {
					unlock()
					return e
				}
			}
		}
		unlock()
	}
	return nil
}
