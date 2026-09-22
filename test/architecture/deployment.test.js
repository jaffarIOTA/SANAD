import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");
const manifests = parseAllDocuments(read("deploy/openshift/origination.yaml")).map((d) => d.toJS()).filter((d) => d !== null && typeof d.kind === "string");
const deployment = manifests.find((m) => m.kind === "Deployment");
const container = deployment?.spec?.["template"].spec.containers[0];
const podSecurity = deployment?.spec?.["template"].spec.securityContext;
const containerfile = read("/services/origination/Containerfile");
describe("OpenShift restricted-v2 compatibility", () => {
  it("pins no UID in the manifest", () => {
    expect(podSecurity?.runAsUser).toBeUndefined();
    expect(container.securityContext?.runAsUser).toBeUndefined();
  });
  it("refuses to run as root", () => {
    expect(podSecurity?.runAsNonRoot).toBe(true);
  });
  it("drops every capability and forbids privilege escalation", () => {
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  });
  it("runs on a read-only root filesystem with a bounded writable mount", () => {
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    const tmp = deployment?.spec?.["template"].spec.volumes.find(
      (v) => v.name === "tmp"
    );
    expect(tmp.emptyDir.sizeLimit).toBeTruthy();
  });
  it("binds an unprivileged port", () => {
    expect(container.ports[0].containerPort).toBeGreaterThan(1024);
  });
  it("grants group 0 access in the image, because the runtime UID is in it", () => {
    expect(containerfile).toMatch(/chgrp -R 0/);
    expect(containerfile).toMatch(/chmod -R g=u/);
  });
  it("declares a non-root USER so the image fails closed elsewhere", () => {
    const user = /^USER\s+(\S+)/m.exec(containerfile);
    expect(user).not.toBeNull();
    expect(user?.[1]).not.toBe("root");
    expect(user?.[1]).not.toBe("0");
  });
});
describe("the deployment does not lose requests", () => {
  it("keeps full capacity through a rollout", () => {
    expect(deployment?.spec?.["strategy"].rollingUpdate.maxUnavailable).toBe(0);
  });
  it("allows longer to terminate than it takes to drain", () => {
    const grace = deployment?.spec?.["template"].spec.terminationGracePeriodSeconds;
    const drain = Number(
      container.env.find((e) => e.name === "DRAIN_MS").value
    );
    expect(grace * 1e3).toBeGreaterThan(drain);
  });
  it("separates liveness from readiness", () => {
    expect(container.livenessProbe.httpGet.path).toBe("/healthz");
    expect(container.readinessProbe.httpGet.path).toBe("/readyz");
  });
  it("keeps one replica available during voluntary disruption", () => {
    const pdb = manifests.find((m) => m.kind === "PodDisruptionBudget");
    expect(pdb?.spec?.["minAvailable"]).toBe(1);
  });
});
describe("the service is not reachable except through the gateway", () => {
  it("publishes no Route", () => {
    expect(manifests.map((m) => m.kind)).not.toContain("Route");
  });
  it("restricts ingress to the gateway namespace", () => {
    const policy = manifests.find((m) => m.kind === "NetworkPolicy");
    expect(policy).toBeDefined();
    expect(policy?.spec?.["policyTypes"]).toContain("Ingress");
    expect(policy?.spec?.["ingress"][0].from[0].namespaceSelector).toBeTruthy();
  });
});
describe("no secret is in the manifest", () => {
  it("references credentials rather than inlining them", () => {
    const raw = read("/deploy/openshift/origination.yaml");
    expect(raw).toMatch(/secretKeyRef/);
    expect(raw).not.toMatch(
      /(token|secret|password|api[_-]?key)\w*:\s*['"]?[A-Za-z0-9_\-+/=]{16,}/i
    );
  });
  it("declares no Secret object, so none can be committed here", () => {
    expect(manifests.map((m) => m.kind)).not.toContain("Secret");
  });
});
