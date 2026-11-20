package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
)

type M = map[string]any

const label = "app.kubernetes.io/managed-by"
const managed = "pi-sandbox-controller"

type grants struct{ Volume *bool }
type request struct {
	Owner, Id, Action, Uid string
	Grants                 *grants
}

var ownerPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var imagePattern = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)

func (r request) valid() bool {
	if !ownerPattern.MatchString(r.Owner) || r.Id == "" || len(r.Id) > 160 {
		return false
	}
	switch r.Action {
	case "lookup", "release":
		return r.Uid != ""
	case "fence":
		return true
	case "check", "warm", "acquire":
		return (r.Action != "check" || r.Uid != "") && r.Grants != nil && r.Grants.Volume != nil
	}
	return false
}

type config struct{ Image, RuntimeClass, Revision, StorageClass, Size string }

func binding(r request, c config, claimUID string) string {
	b, _ := json.Marshal([]any{r.Owner, r.Grants, c, claimUID})
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
func env(n, v string) M { return M{"name": n, "value": v} }
func manifest(r request, c config, claim, b string, now int64) M {
	data := M{"name": "data"}
	if claim != "" {
		data["persistentVolumeClaim"] = M{"claimName": claim}
	} else {
		data["emptyDir"] = M{"sizeLimit": "256Mi"}
	}
	key := make([]byte, 32)
	rand.Read(key)
	container := M{"name": "sandbox", "image": c.Image, "env": []M{env("RUNTIME_KEY", hex.EncodeToString(key))}, "securityContext": M{"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "capabilities": M{"drop": []string{"ALL"}}}, "resources": M{"requests": M{"cpu": "50m", "memory": "48Mi"}, "limits": M{"cpu": "1", "memory": "256Mi"}}, "readinessProbe": M{"tcpSocket": M{"port": 8282}}, "volumeMounts": []M{{"name": "data", "mountPath": "/workspace"}, {"name": "tmp", "mountPath": "/tmp"}}}
	spec := M{"automountServiceAccountToken": false, "enableServiceLinks": false, "restartPolicy": "Never", "securityContext": M{"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532, "fsGroup": 65532, "seccompProfile": M{"type": "RuntimeDefault"}}, "volumes": []M{data, {"name": "tmp", "emptyDir": M{"sizeLimit": "32Mi"}}}, "containers": []M{container}}
	if c.RuntimeClass != "" {
		spec["runtimeClassName"] = c.RuntimeClass
	}
	return M{"apiVersion": "v1", "kind": "Pod", "metadata": M{"name": "sb-" + r.Owner[:48], "labels": M{label: managed}, "annotations": M{"owner": r.Owner, "binding": b, "activity": strconv.FormatInt(now, 10)}}, "spec": spec}
}
