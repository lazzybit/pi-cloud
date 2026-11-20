package ticket

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestCommandDigestContract(t *testing.T) {
	raw, err := os.ReadFile("../../protocol/command-digest.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Command, Digest string }
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("no digest vectors")
	}
	const key, uid, boot, id = "fixture", "pod-a", "boot-a", "call-a"
	now := time.Unix(1700000000, 0)
	expiry := strconv.FormatInt(now.Add(time.Second).UnixMilli(), 10)
	for _, v := range vectors {
		signed := expiry + "." + startMAC(key, uid, boot, id, v.Digest, expiry)
		if !Valid(key, uid, boot, id, v.Command, signed, now) {
			t.Errorf("rejected digest for %q", v.Command)
		}
	}
}
