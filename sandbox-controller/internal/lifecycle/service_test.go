package lifecycle

import (
	"context"
	"strings"
	"testing"
	"time"
)

type memory struct {
	pod              *Pod
	creates, deletes int
	updated          Lease
}

func (m *memory) ReadPod(context.Context, string) (*Pod, error) { return m.pod, nil }
func (m *memory) CreatePod(_ context.Context, name, owner, claim, binding string, now time.Time) error {
	m.creates++
	m.pod = &Pod{Name: name, Owner: owner, Binding: binding, Managed: true, UID: "new", Activity: now}
	return nil
}
func (m *memory) DeletePod(context.Context, Pod) error { m.deletes++; m.pod = nil; return nil }
func (m *memory) UpdateLease(_ context.Context, _ Pod, l Lease) error {
	m.updated = l
	m.pod.Lease = l
	return nil
}
func (m *memory) Claim(context.Context, string, string) (string, error) { return "claim-uid", nil }
func (m *memory) ListPods(context.Context) ([]Pod, error) {
	if m.pod == nil {
		return nil, nil
	}
	return []Pod{*m.pod}, nil
}

func TestVolumeGrantChangeFencesRatherThanValidatesOldPod(t *testing.T) {
	ctx := context.Background()
	m := new(memory)
	s := New(m, "config", time.Minute)
	yes, no := true, false
	req := Request{Owner: "0123456789012345678901234567890123456789012345678901234567890123", ID: strings.Repeat("1", 64), Action: "acquire", Grants: &Grants{Volume: &yes}}
	if out, err := s.Act(ctx, req); err != nil || !out.Pending || m.pod == nil {
		t.Fatal(out, err)
	}
	m.pod.Ready = true
	m.pod.TicketKey = "fixture"
	m.pod.Endpoint = Endpoint{URL: "http://localhost", Key: "fixture", UID: m.pod.UID}
	if out, err := s.Act(ctx, req); err != nil || out.Endpoint.UID != m.pod.UID || m.updated.ID != req.ID {
		t.Fatal(out, err)
	}
	req.Action = "check"
	req.UID = m.pod.UID
	req.Boot = strings.Repeat("2", 32)
	req.Digest = strings.Repeat("3", 64)
	if out, err := s.Act(ctx, req); err != nil || !out.Valid || out.Ticket == "" {
		t.Fatal(out, err)
	}
	req.Grants.Volume = &no
	if out, err := s.Act(ctx, req); err != nil || out.Valid || m.deletes != 1 || m.creates != 1 {
		t.Fatal(out, err, m.creates, m.deletes)
	}
}

func TestSweepRespectsLeaseAndRereadsGeneration(t *testing.T) {
	now := time.Now()
	m := &memory{pod: &Pod{Name: "sb-012345678901234567890123456789012345678901234567", UID: "a", Managed: true, Activity: now.Add(-2 * time.Minute), Lease: Lease{ID: "call", Until: now.Add(time.Minute)}}}
	s := New(m, "config", time.Minute)
	if err := s.Sweep(context.Background()); err != nil || m.deletes != 0 {
		t.Fatal(err, m.deletes)
	}
	m.pod.Lease.Until = now.Add(-2 * time.Minute)
	if err := s.Sweep(context.Background()); err != nil || m.deletes != 1 {
		t.Fatal(err, m.deletes)
	}
}
