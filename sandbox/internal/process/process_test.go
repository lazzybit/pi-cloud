package process

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGuardedProcess(t *testing.T) {
	dir := t.TempDir()
	guard := filepath.Join(dir, "guard")
	if out, err := exec.Command("cc", "-Os", "-static", "../../guard/guard.c", "-o", guard).CombinedOutput(); err != nil {
		t.Fatalf("compile guard: %v: %s", err, out)
	}
	workspace := filepath.Join(dir, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RUNTIME_KEY", "fixture-key")
	r := Runner{Guard: guard, Workspace: workspace, Limit: time.Second}
	if err := r.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	run := func(cmd string) Result { return r.Run(context.Background(), cmd, new(Stream), new(Stream)) }
	got := run("printf out; printf err >&2; exit 7")
	if got.Stdout != "out" || got.Stderr != "err" || got.ExitCode != 7 {
		t.Fatal(got)
	}
	got = run(`python3 -c 'print("a" * 24000)'; printf tail >&2`)
	if got.ExitCode != 0 || got.Stderr != "tail" || !strings.HasSuffix(got.Stdout, "[truncated]") {
		t.Fatal(got.ExitCode, len(got.Stdout), got.Stderr)
	}
	got = run("exec sleep 60")
	if !got.TimedOut || got.ExitCode == 0 {
		t.Fatal(got)
	}
	got = run("(sleep 2; printf bad > marker) & printf done")
	if got.TimedOut || got.Stdout != "done" {
		t.Fatal(got)
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(workspace, "marker")); !os.IsNotExist(err) {
		t.Fatal("background child survived", err)
	}
	got = run(`test -z "$RUNTIME_KEY"`)
	if got.ExitCode != 0 {
		t.Fatal("guard inherited runtime key", got)
	}
	r.Guard = "/missing/guard"
	if got := run("printf bad > marker"); got.ExitCode == 0 {
		t.Fatal("missing guard did not fail closed")
	}
}
