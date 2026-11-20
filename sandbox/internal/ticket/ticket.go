package ticket

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

const ticketWindow = 10 * time.Second

func mac(key, message string) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(message))
	return hex.EncodeToString(h.Sum(nil))
}
func ManagementKey(key string) string { return mac(key, "pi-sandbox:observe-cancel:v1") }
func startMAC(key, uid, boot, id, digest, expiry string) string {
	return mac(key, strings.Join([]string{"pi-sandbox:start:v1", uid, boot, id, digest, expiry}, "\n"))
}

func Valid(key, uid, boot, id, command, credential string, now time.Time) bool {
	expiry, sig, ok := strings.Cut(credential, ".")
	if !ok || len(sig) != 64 {
		return false
	}
	ms, err := strconv.ParseInt(expiry, 10, 64)
	if err != nil {
		return false
	}
	end := time.UnixMilli(ms)
	if !end.After(now) || end.Sub(now) > ticketWindow+2*time.Second {
		return false
	}
	digest := sha256.Sum256([]byte(command))
	expected := startMAC(key, uid, boot, id, hex.EncodeToString(digest[:]), expiry)
	return hmac.Equal([]byte(expected), []byte(sig))
}
