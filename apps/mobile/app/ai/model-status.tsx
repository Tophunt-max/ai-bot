import type { ModelStatus } from "@atb/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorText, Loading, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

const LADDER: ModelStatus[] = ["DRAFT", "VALIDATING", "PAPER", "SHADOW", "CANARY", "PRODUCTION"];

export default function ModelStatusScreen() {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const portfolio = useQuery({ queryKey: qk.portfolio, queryFn: api.portfolio });
  const m = useMutation({
    mutationFn: (v: { id: string; status: ModelStatus }) =>
      api.setModelStatus(v.id, v.status, "changed from app"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["models"] }),
  });

  return (
    <Screen title="Model status">
      <Card title="Live engine">
        <Row
          label="AI status"
          value={portfolio.data?.aiStatus ?? "—"}
          tone={portfolio.data?.aiStatus === "ACTIVE" ? "good" : "warn"}
        />
        <Row label="Rules ensemble" value="rules-ensemble-1.0.0" />
      </Card>
      {models.isLoading ? <Loading /> : null}
      {models.error ? <ErrorText error={models.error} /> : null}
      {m.error ? <ErrorText error={m.error} /> : null}
      {(models.data ?? []).map((mv) => {
        const oos = JSON.parse(mv.out_of_sample_metrics || "{}") as Record<string, unknown>;
        const idx = LADDER.indexOf(mv.status);
        const next = idx >= 0 && idx < LADDER.length - 1 ? LADDER[idx + 1] : undefined;
        return (
          <Card key={mv.id} title={`${mv.model_id} · ${mv.version}`}>
            <Row label="Status" value={mv.status} tone={mv.status === "PRODUCTION" ? "good" : undefined} />
            <Row
              label="OOS verdict"
              value={String(oos.verdict ?? "—")}
              tone={oos.verdict === "PASS" ? "good" : "bad"}
            />
            <Row label="OOS AUC" value={oos.auc !== undefined ? Number(oos.auc).toFixed(3) : "—"} />
            <Row
              label="Expectancy uplift"
              value={oos.uplift_r !== undefined ? `${Number(oos.uplift_r).toFixed(2)}R` : "—"}
            />
            {next ? (
              <Button
                label={`Promote → ${next}`}
                disabled={oos.verdict !== "PASS" || m.isPending}
                onPress={() => m.mutate({ id: mv.id, status: next })}
              />
            ) : null}
            {mv.status !== "RETIRED" ? (
              <Button
                label="Retire"
                tone="ghost"
                onPress={() => m.mutate({ id: mv.id, status: "RETIRED" })}
              />
            ) : null}
          </Card>
        );
      })}
      <Muted>
        One stage at a time. A model that failed out-of-sample validation cannot be promoted from the app, and
        nothing is auto-deployed to production.
      </Muted>
    </Screen>
  );
}
