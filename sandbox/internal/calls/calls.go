package calls

import (
	"context"
	"crypto/sha256"
	"sync"

	"pi-cloud/sandbox/internal/process"
)

const retained = 128

type Status string

const (
	Missing  Status = "missing"
	Stale    Status = "stale"
	Conflict Status = "conflict"
	Busy     Status = "busy"
	Running  Status = "running"
	Done     Status = "done"
)

type Observation struct {
	State   Status          `json:"state"`
	Preview *process.Output `json:"preview,omitempty"`
	Result  *process.Result `json:"result,omitempty"`
}
type Run func(context.Context, string, *process.Stream, *process.Stream) process.Result
type call struct {
	digest         [32]byte
	stdout, stderr process.Stream
	result         *process.Result
	cancel         context.CancelFunc
}

type Service struct {
	mu      sync.Mutex
	wait    sync.WaitGroup
	boot    string
	run     Run
	closing bool
	active  *call
	calls   map[string]*call
	order   []string
}

func New(boot string, run Run) *Service {
	return &Service{boot: boot, run: run, calls: make(map[string]*call)}
}
func (s *Service) Health() (string, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil {
		return s.boot, 1
	}
	return s.boot, 0
}
func (s *Service) Start(boot, id, command string) Observation {
	s.mu.Lock()
	defer s.mu.Unlock()
	if boot != s.boot || s.closing {
		return Observation{State: Stale}
	}
	digest := sha256.Sum256([]byte(command))
	if c := s.calls[id]; c != nil {
		if digest != c.digest {
			return Observation{State: Conflict}
		}
		return snapshot(c)
	}
	if s.active != nil {
		return Observation{State: Busy}
	}
	if len(s.order) >= retained {
		delete(s.calls, s.order[0])
		s.order = s.order[1:]
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &call{digest: digest, cancel: cancel}
	s.active = c
	s.calls[id] = c
	s.order = append(s.order, id)
	s.wait.Go(func() {
		result := s.run(ctx, command, &c.stdout, &c.stderr)
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		c.result = &result
		s.active = nil
	})
	return snapshot(c)
}
func (s *Service) Observe(boot, id string) Observation {
	s.mu.Lock()
	defer s.mu.Unlock()
	if boot != s.boot {
		return Observation{State: Stale}
	}
	return snapshot(s.calls[id])
}
func (s *Service) Cancel(boot, id string) Observation {
	s.mu.Lock()
	defer s.mu.Unlock()
	if boot != s.boot {
		return Observation{State: Stale}
	}
	c := s.calls[id]
	if c != nil && c == s.active {
		c.cancel()
	}
	return snapshot(c)
}
func (s *Service) Close() {
	s.mu.Lock()
	s.closing = true
	if s.active != nil {
		s.active.cancel()
	}
	s.mu.Unlock()
	s.wait.Wait()
}
func snapshot(c *call) Observation {
	if c == nil {
		return Observation{State: Missing}
	}
	if c.result != nil {
		return Observation{State: Done, Result: c.result}
	}
	return Observation{State: Running, Preview: &process.Output{Stdout: c.stdout.Preview(), Stderr: c.stderr.Preview()}}
}
