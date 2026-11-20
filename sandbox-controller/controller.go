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
func isPodReady(pod *object) bool {
	if pod == nil {
		return false
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == "Ready" && condition.Status == "True" {
			return true
		}
	}
	return false
}

func needsReplacement(pod *object, desiredBinding string) bool {
	if pod == nil {
		return false
	}
	return pod.Metadata.Annotations["binding"] != desiredBinding || pod.Status.Phase == "Failed" || pod.Status.Phase == "Succeeded"
}

func (h *controller) personalVolume(ctx context.Context, r request) (name, uid string, err error) {
	if !*r.Grants.Volume {
		return "", "", nil
	}
	name = "pv-" + r.Owner[:48]
	claim, err := h.k(ctx, "GET", "persistentvolumeclaims/"+name, nil)
	if err != nil {
		return "", "", err
	}
	if claim == nil {
		spec := M{"accessModes": []string{"ReadWriteOncePod"}, "resources": M{"requests": M{"storage": h.c.Size}}}
		if h.c.StorageClass != "" {
			spec["storageClassName"] = h.c.StorageClass
		}
		claim, err = h.k(ctx, "POST", "persistentvolumeclaims", M{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": M{"name": name, "labels": M{label: managed}, "annotations": M{"owner": r.Owner}}, "spec": spec})
		if err != nil {
			return "", "", err
		}
	}
	if claim.Metadata.Annotations["owner"] != r.Owner || claim.Metadata.DeletionTimestamp != "" || claim.Metadata.UID == "" {
		return "", "", errors.New("invalid personal claim")
	}

	return name, claim.Metadata.UID, nil
}

func (h *controller) act(ctx context.Context, r request) (M, error) {
	if !r.valid() {
		return nil, errors.New("invalid request")
	}
	name := "sb-" + r.Owner[:48]
	unlock := h.lock(name)
	defer unlock()
	pod, err := h.k(ctx, "GET", "pods/"+name, nil)
	if err != nil {
		return nil, err
	}
	annotations := map[string]string{}
	if pod != nil {
		if pod.Metadata.Labels[label] != managed || pod.Metadata.Annotations["owner"] != r.Owner {
			return nil, errors.New("not owned")
		}
		annotations = pod.Metadata.Annotations
	}
	now := time.Now().UnixMilli()
	ms := func(n int64) string { return strconv.FormatInt(n, 10) }
	updateAnnotations := func(fields M) (M, error) {
		_, err := h.k(ctx, "PATCH", "pods/"+name, M{"metadata": M{"resourceVersion": pod.Metadata.ResourceVersion, "annotations": fields}})
		return M{}, err
	}
	endpoint := func() (M, error) {
		if net.ParseIP(pod.Status.PodIP) != nil && len(pod.Spec.Containers) > 0 {
			for _, v := range pod.Spec.Containers[0].Env {
				if v.Name == "RUNTIME_KEY" && v.Value != "" {
					return M{"url": "http://" + net.JoinHostPort(pod.Status.PodIP, "8282"), "key": v.Value, "uid": pod.Metadata.UID}, nil
				}
			}
		}
		return nil, errors.New("missing endpoint")
	}
	switch r.Action {
	case "fence":
		if pod != nil && pod.Metadata.DeletionTimestamp == "" {
			return M{}, h.remove(ctx, pod)
		}
		return M{}, nil
	case "release":
		if pod != nil && pod.Metadata.UID == r.Uid && annotations["lease"] == r.Id {
			return updateAnnotations(M{"activity": ms(now), "lease": nil, "until": nil})
		}
		return M{}, nil
	case "lookup":
		if pod != nil && pod.Metadata.UID == r.Uid && pod.Metadata.DeletionTimestamp == "" {
			return endpoint()
		}
		return M{"missing": true}, nil
	}
	pending := M{"pending": true}
	if pod != nil && pod.Metadata.DeletionTimestamp != "" {
		return pending, nil
	}
	claim, claimUID, err := h.personalVolume(ctx, r)
	if err != nil {
		return nil, err
	}
	desiredBinding := binding(r, h.c, claimUID)
	if needsReplacement(pod, desiredBinding) {
		return pending, h.remove(ctx, pod)
	}
	ready := isPodReady(pod)
	leaseExpiresAt, _ := strconv.ParseInt(annotations["until"], 10, 64)
	if r.Action == "check" {
		return M{"valid": ready && pod.Metadata.UID == r.Uid && annotations["lease"] == r.Id && leaseExpiresAt > now}, nil
	}
	if pod == nil {
		_, err = h.k(ctx, "POST", "pods", manifest(r, h.c, claim, desiredBinding, now))
		return pending, err
	}
	if !ready {
		return pending, nil
	}
	if r.Action == "warm" {
		if annotations["lastWarm"] != r.Id {
			_, err = updateAnnotations(M{"activity": ms(now), "lastWarm": r.Id})
		}
		return M{"ready": true}, err
	}
	leasedToAnotherCall := annotations["lease"] != "" && annotations["lease"] != r.Id && leaseExpiresAt > now
	if leasedToAnotherCall {
		return pending, nil
	}
	if _, err = updateAnnotations(M{"lease": r.Id, "until": ms(now + 90000)}); err != nil {
		return nil, err
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
