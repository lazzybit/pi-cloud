package main

import (
	"strings"
	"testing"
)

func TestSandboxProcessLimitIsPrivateToEachPod(t *testing.T) {
	for _, claim := range []string{"", "personal-volume"} {
		on := true
		r := request{Owner: strings.Repeat("a", 64), Grants: &grants{Volume: &on, Web: &on}}
		spec := manifest(r, config{}, claim, "binding", 1)["spec"].(M)
		if spec["hostUsers"] != false {
			t.Fatalf("claim %q shares the host UID's process limit", claim)
		}
	}
}
