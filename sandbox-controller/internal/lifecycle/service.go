package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"sync"
	"time"
)

var hexBoot = regexp.MustCompile(`^[a-f0-9]{32}$`)
var ownerFormat = regexp.MustCompile(`^[a-f0-9]{64}$`)
var podFormat = regexp.MustCompile(`^sb-[a-f0-9]{48}$`)

type Grants struct {
	Volume *bool `json:"volume"`
}
type Request struct {
	Action string  `json:"action"`
	Owner  string  `json:"owner"`
	ID     string  `json:"id"`
	UID    string  `json:"uid"`
	Grants *Grants `json:"grants"`
	Boot   string  `json:"boot"`
	Digest string  `json:"digest"`
}

func (r Request) Valid() bool {
	if !ownerFormat.MatchString(r.Owner) || r.ID == "" || len(r.ID) > 160 {
		return false
	}
	switch r.Action {
	case "lookup", "release":
		return r.UID != ""
	case "fence":
		return true
	case "check":
		return r.UID != "" && hexBoot.MatchString(r.Boot) && ownerFormat.MatchString(r.Digest) && ownerFormat.MatchString(r.ID) && r.Grants != nil && r.Grants.Volume != nil
	case "warm", "acquire":
		return r.Grants != nil && r.Grants.Volume != nil
	default:
		return false
	}
}

type Endpoint struct {
	UID string `json:"uid,omitempty"`
	URL string `json:"url,omitempty"`
	Key string `json:"key,omitempty"`
}
type Response struct {
	Endpoint
	Pending bool   `json:"pending,omitempty"`
	Ready   bool   `json:"ready,omitempty"`
	Valid   bool   `json:"valid,omitempty"`
	Ticket  string `json:"ticket,omitempty"`
	Missing bool   `json:"missing,omitempty"`
}
type Lease struct {
	ID       string
	Until    time.Time
	Activity time.Time
	LastWarm string
}
type Pod struct {
	Name, UID, Version, Owner, Binding    string
	Managed, Terminating, Ready, Terminal bool
	Endpoint                              Endpoint
	TicketKey                             string
	Lease                                 Lease
	Activity                              time.Time
}
type Store interface {
	ReadPod(context.Context, string) (*Pod, error)
	CreatePod(ctx context.Context, name, owner, claim, binding string, now time.Time) error
	DeletePod(context.Context, Pod) error
	UpdateLease(context.Context, Pod, Lease) error
	Claim(ctx context.Context, name, owner string) (uid string, err error)
	ListPods(context.Context) ([]Pod, error)
}
type Service struct {
	store    Store
	configID string
	idle     time.Duration
	locks    [256]sync.Mutex
}

func New(store Store, configID string, idle time.Duration) *Service {
	return &Service{store: store, configID: configID, idle: idle}
}
func (s *Service) lock(name string) func() {
	v, _ := strconv.ParseUint(name[3:5], 16, 8)
	l := &s.locks[v]
	l.Lock()
	return l.Unlock
}
func (s *Service) Act(ctx context.Context, r Request) (Response, error) {
	if !r.Valid() {
		return Response{}, errors.New("invalid lifecycle request")
	}
	name := "sb-" + r.Owner[:48]
	unlock := s.lock(name)
	defer unlock()
	p, err := s.store.ReadPod(ctx, name)
	if err != nil {
		return Response{}, err
	}
	if p != nil && (!p.Managed || p.Owner != r.Owner) {
		return Response{}, errors.New("sandbox not owned")
	}
	now := time.Now()
	switch r.Action {
	case "fence":
		if p != nil && !p.Terminating {
			return Response{}, s.store.DeletePod(ctx, *p)
		}
		return Response{}, nil
	case "release":
		if p != nil && !p.Terminating && p.UID == r.UID && p.Lease.ID == r.ID {
			next := p.Lease
			next.ID = ""
			next.Until = time.Time{}
			next.Activity = now
			return Response{}, s.store.UpdateLease(ctx, *p, next)
		}
		return Response{}, nil
	case "lookup":
		if p == nil || p.Terminating || p.UID != r.UID {
			return Response{Missing: true}, nil
		}
		return endpoint(p)
	}
	pending := Response{Pending: true}
	if p != nil && p.Terminating {
		return pending, nil
	}
	var claim, claimUID string
	if *r.Grants.Volume {
		claim = "pv-" + r.Owner[:48]
		claimUID, err = s.store.Claim(ctx, claim, r.Owner)
		if err != nil {
			return Response{}, err
		}
	}
	encoded, _ := json.Marshal([]any{r.Owner, *r.Grants.Volume, claimUID, s.configID})
	digest := sha256.Sum256(encoded)
	binding := hex.EncodeToString(digest[:])
	if p != nil && (p.Binding != binding || p.Terminal) {
		return pending, s.store.DeletePod(ctx, *p)
	}
	if r.Action == "check" {
		if p == nil || !p.Ready || p.UID != r.UID || p.Lease.ID != r.ID || !p.Lease.Until.After(now) || p.TicketKey == "" {
			return Response{}, nil
		}
		deadline := now.Add(ticketWindow)
		if p.Lease.Until.Before(deadline) {
			deadline = p.Lease.Until
		}
		return Response{Valid: true, Ticket: signStart(p.TicketKey, p.UID, r.Boot, r.ID, r.Digest, deadline)}, nil
	}
	if p == nil {
		return pending, s.store.CreatePod(ctx, name, r.Owner, claim, binding, now)
	}
	if !p.Ready {
		return pending, nil
	}
	next := p.Lease
	if r.Action == "warm" {
		if next.LastWarm != r.ID {
			next.LastWarm = r.ID
			next.Activity = now
			err = s.store.UpdateLease(ctx, *p, next)
		}
		return Response{Ready: true}, err
	}
	if next.ID != "" && next.ID != r.ID && next.Until.After(now) {
		return pending, nil
	}
	out, err := endpoint(p)
	if err != nil {
		return Response{}, err
	}
	next.ID = r.ID
	next.Until = now.Add(90 * time.Second)
	if err := s.store.UpdateLease(ctx, *p, next); err != nil {
		return Response{}, err
	}
	return out, nil
}
func endpoint(p *Pod) (Response, error) {
	if p.Endpoint.URL == "" || p.Endpoint.Key == "" || p.UID == "" {
		return Response{}, errors.New("sandbox endpoint unavailable")
	}
	return Response{Endpoint: p.Endpoint}, nil
}
func (s *Service) Sweep(ctx context.Context) error {
	pods, err := s.store.ListPods(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, p := range pods {
		if !podFormat.MatchString(p.Name) {
			continue
		}
		if err := s.evictIdle(ctx, p.Name, p.UID); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
func (s *Service) evictIdle(ctx context.Context, name, uid string) error {
	unlock := s.lock(name)
	defer unlock()
	p, err := s.store.ReadPod(ctx, name)
	if err != nil || p == nil || p.UID != uid || !p.Managed || p.Terminating {
		return err
	}
	if p.Activity.IsZero() {
		return nil
	}
	now := time.Now()
	if p.Lease.Until.After(now) {
		return nil
	}
	last := p.Activity
	if p.Lease.Until.After(last) {
		last = p.Lease.Until
	}
	if now.Sub(last) < s.idle {
		return nil
	}
	return s.store.DeletePod(ctx, *p)
}
