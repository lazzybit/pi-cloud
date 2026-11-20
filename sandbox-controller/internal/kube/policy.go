package kube

import (
	"time"

	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func ptr[T any](v T) *T { return &v }
func podSpec(ns string, c Config, name, owner, claim, binding, key string, now time.Time) *core.Pod {
	data := core.Volume{Name: "data", VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{SizeLimit: ptr(resource.MustParse("256Mi"))}}}
	if claim != "" {
		data.VolumeSource = core.VolumeSource{PersistentVolumeClaim: &core.PersistentVolumeClaimVolumeSource{ClaimName: claim}}
	}
	p := &core.Pod{
		ObjectMeta: meta.ObjectMeta{Name: name, Namespace: ns, Labels: map[string]string{managedLabel: manager}, Annotations: map[string]string{"owner": owner, "binding": binding, "activity": millis(now)}},
		Spec: core.PodSpec{
			AutomountServiceAccountToken: ptr(false), EnableServiceLinks: ptr(false), RestartPolicy: core.RestartPolicyNever,
			SecurityContext: &core.PodSecurityContext{RunAsNonRoot: ptr(true), RunAsUser: ptr(int64(65532)), RunAsGroup: ptr(int64(65532)), FSGroup: ptr(int64(65532)), SeccompProfile: &core.SeccompProfile{Type: core.SeccompProfileTypeRuntimeDefault}},
			Volumes:         []core.Volume{data, {Name: "tmp", VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{SizeLimit: ptr(resource.MustParse("32Mi"))}}}},
			Containers: []core.Container{{
				Name: "sandbox", Image: c.Image, Env: []core.EnvVar{{Name: "RUNTIME_KEY", Value: key}, {Name: "SANDBOX_POD_UID", ValueFrom: &core.EnvVarSource{FieldRef: &core.ObjectFieldSelector{FieldPath: "metadata.uid"}}}},
				SecurityContext: &core.SecurityContext{AllowPrivilegeEscalation: ptr(false), ReadOnlyRootFilesystem: ptr(true), Capabilities: &core.Capabilities{Drop: []core.Capability{"ALL"}}},
				Resources:       core.ResourceRequirements{Requests: core.ResourceList{core.ResourceCPU: resource.MustParse("50m"), core.ResourceMemory: resource.MustParse("48Mi")}, Limits: core.ResourceList{core.ResourceCPU: resource.MustParse("1"), core.ResourceMemory: resource.MustParse("256Mi")}},
				ReadinessProbe:  &core.Probe{ProbeHandler: core.ProbeHandler{TCPSocket: &core.TCPSocketAction{Port: intstr.FromInt32(8282)}}},
				VolumeMounts:    []core.VolumeMount{{Name: "data", MountPath: "/workspace"}, {Name: "tmp", MountPath: "/tmp"}},
			}},
		},
	}
	if c.RuntimeClass != "" {
		p.Spec.RuntimeClassName = &c.RuntimeClass
	}
	return p
}
