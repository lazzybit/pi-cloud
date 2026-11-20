package kube

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"

	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"pi-cloud/sandbox-controller/internal/lifecycle"
)

const managedLabel = "app.kubernetes.io/managed-by"
const manager = "pi-sandbox-controller"

type Config struct {
	Image, RuntimeClass, Revision, StorageClass string
	Size                                        resource.Quantity
}

func (c Config) ID() string { bytes, _ := json.Marshal(c); return string(bytes) }

type Store struct {
	client    client.Client
	namespace string
	config    Config
}

func Connect(cfg *rest.Config, namespace string, c Config, transport *http.Client) (*Store, error) {
	scheme := runtime.NewScheme()
	if err := core.AddToScheme(scheme); err != nil {
		return nil, err
	}
	// Only core/v1 Pod and PVC are accessed. No discovery or informer cache is needed.
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{core.SchemeGroupVersion})
	mapper.Add(core.SchemeGroupVersion.WithKind("Pod"), meta.RESTScopeNamespace)
	mapper.Add(core.SchemeGroupVersion.WithKind("PersistentVolumeClaim"), meta.RESTScopeNamespace)
	opts := client.Options{Scheme: scheme, Mapper: mapper, HTTPClient: transport}
	k, err := client.New(cfg, opts)
	if err != nil {
		return nil, err
	}
	return &Store{client: k, namespace: namespace, config: c}, nil
}
func InCluster(namespace string, c Config) (*Store, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	cfg.Timeout = 8 * time.Second
	return Connect(cfg, namespace, c, nil)
}
func (s *Store) key(name string) client.ObjectKey {
	return client.ObjectKey{Namespace: s.namespace, Name: name}
}
func (s *Store) ReadPod(ctx context.Context, name string) (*lifecycle.Pod, error) {
	var p core.Pod
	if err := s.client.Get(ctx, s.key(name), &p); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	v := observe(p)
	return &v, nil
}
func (s *Store) ListPods(ctx context.Context) ([]lifecycle.Pod, error) {
	var p core.PodList
	if err := s.client.List(ctx, &p, client.InNamespace(s.namespace), client.MatchingLabels{managedLabel: manager}); err != nil {
		return nil, err
	}
	out := make([]lifecycle.Pod, 0, len(p.Items))
	for _, item := range p.Items {
		out = append(out, observe(item))
	}
	return out, nil
}
func (s *Store) DeletePod(ctx context.Context, p lifecycle.Pod) error {
	if p.UID == "" || p.Version == "" {
		return errors.New("missing pod precondition")
	}
	uid := types.UID(p.UID)
	err := s.client.Delete(ctx, &core.Pod{ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: s.namespace}}, client.Preconditions{UID: &uid, ResourceVersion: &p.Version})
	return client.IgnoreNotFound(err)
}
func (s *Store) UpdateLease(ctx context.Context, p lifecycle.Pod, l lifecycle.Lease) error {
	if p.Version == "" {
		return errors.New("missing pod version")
	}
	data, err := json.Marshal(map[string]any{"metadata": map[string]any{"resourceVersion": p.Version, "annotations": map[string]any{
		"lease": optional(l.ID), "until": optional(millis(l.Until)), "activity": millis(l.Activity), "lastWarm": optional(l.LastWarm),
	}}})
	if err != nil {
		return err
	}
	return s.client.Patch(ctx, &core.Pod{ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: s.namespace}}, client.RawPatch(types.MergePatchType, data))
}
func (s *Store) Claim(ctx context.Context, name, owner string) (string, error) {
	var pvc core.PersistentVolumeClaim
	err := s.client.Get(ctx, s.key(name), &pvc)
	if apierrors.IsNotFound(err) {
		pvc = core.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: s.namespace, Labels: map[string]string{managedLabel: manager}, Annotations: map[string]string{"owner": owner}}, Spec: core.PersistentVolumeClaimSpec{
			AccessModes: []core.PersistentVolumeAccessMode{core.ReadWriteOncePod}, Resources: core.VolumeResourceRequirements{Requests: core.ResourceList{core.ResourceStorage: s.config.Size}},
		}}
		if s.config.StorageClass != "" {
			pvc.Spec.StorageClassName = &s.config.StorageClass
		}
		err = s.client.Create(ctx, &pvc)
		if apierrors.IsAlreadyExists(err) {
			err = s.client.Get(ctx, s.key(name), &pvc)
		}
	}
	if err != nil {
		return "", err
	}
	if pvc.Annotations["owner"] != owner || pvc.UID == "" || pvc.DeletionTimestamp != nil {
		return "", errors.New("invalid personal claim")
	}
	return string(pvc.UID), nil
}
func (s *Store) CreatePod(ctx context.Context, name, owner, claim, binding string, now time.Time) error {
	var key [32]byte
	rand.Read(key[:])
	p := podSpec(s.namespace, s.config, name, owner, claim, binding, hex.EncodeToString(key[:]), now)
	if err := s.client.Create(ctx, p); err != nil && !apierrors.IsAlreadyExists(err) {
		return err
	}
	return nil
}
func observe(p core.Pod) lifecycle.Pod {
	a := p.Annotations
	out := lifecycle.Pod{Name: p.Name, UID: string(p.UID), Version: p.ResourceVersion, Owner: a["owner"], Binding: a["binding"], Managed: p.Labels[managedLabel] == manager, Terminating: p.DeletionTimestamp != nil, Terminal: p.Status.Phase == core.PodFailed || p.Status.Phase == core.PodSucceeded, Activity: fromMillis(a["activity"]), Lease: lifecycle.Lease{ID: a["lease"], Until: fromMillis(a["until"]), Activity: fromMillis(a["activity"]), LastWarm: a["lastWarm"]}}
	for _, condition := range p.Status.Conditions {
		if condition.Type == core.PodReady && condition.Status == core.ConditionTrue {
			out.Ready = true
			break
		}
	}
	if net.ParseIP(p.Status.PodIP) != nil {
		for _, c := range p.Spec.Containers {
			if c.Name == "sandbox" {
				for _, v := range c.Env {
					if v.Name == "RUNTIME_KEY" && v.Value != "" {
						out.Endpoint = lifecycle.Endpoint{UID: out.UID, URL: "http://" + net.JoinHostPort(p.Status.PodIP, "8282"), Key: lifecycle.ManagementKey(v.Value)}
						out.TicketKey = v.Value
					}
				}
			}
		}
	}
	return out
}
func optional(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func millis(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return strconv.FormatInt(t.UnixMilli(), 10)
}
func fromMillis(s string) time.Time {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.UnixMilli(v)
}
