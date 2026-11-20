package lifecycle

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

func signStart(key, uid, boot, id, digest string, expires time.Time) string {
	expiry := strconv.FormatInt(expires.UnixMilli(), 10)
	return expiry + "." + startMAC(key, uid, boot, id, digest, expiry)
}
