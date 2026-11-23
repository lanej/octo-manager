package tui

import (
	"slices"
	"strings"
	"testing"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func deliveryFixture() (*Model, *v1.TrackedPullRequest) {
	pr := &v1.TrackedPullRequest{
		Id: "pr", Url: "https://github.com/owner/repo/pull/1",
		OwnerAgentId: "owner", Enabled: true,
		TrackingState: v1.TrackingState_TRACKING_STATE_WATCHING,
		Observation: &v1.TrackingObservation{
			Id: 1, ObservedAtMs: 1700000000000, Lifecycle: "open",
			HeadSha: strings.Repeat("a", 40), Mergeability: "mergeable",
			TargetBase: &v1.TargetBase{Ref: "main", Sha: strings.Repeat("b", 40)},
			Checks: &v1.DomainCheckEvidence{Variant: &v1.DomainCheckEvidence_Variant_1{Variant_1: &v1.DomainCheckEvidenceVariant1{
				State: new(v1.DomainCheckEvidenceVariant1State_DOMAIN_CHECK_EVIDENCE_VARIANT1_STATE_COMPLETE),
			}}},
			Workflows: &v1.DomainCheckEvidence{Variant: &v1.DomainCheckEvidence_Variant_1{Variant_1: &v1.DomainCheckEvidenceVariant1{
				State: new(v1.DomainCheckEvidenceVariant1State_DOMAIN_CHECK_EVIDENCE_VARIANT1_STATE_COMPLETE),
			}}},
			Reviews: &v1.DomainReviewEvidence{Variant: &v1.DomainReviewEvidence_Variant_1{Variant_1: &v1.DomainReviewEvidenceVariant1{
				State: new(v1.DomainReviewEvidenceVariant1State_DOMAIN_REVIEW_EVIDENCE_VARIANT1_STATE_COMPLETE),
			}}},
			Feedback: &v1.DomainFeedbackEvidence{Variant: &v1.DomainFeedbackEvidence_Variant_1{Variant_1: &v1.DomainFeedbackEvidenceVariant1{
				State: new(v1.DomainFeedbackEvidenceVariant1State_DOMAIN_FEEDBACK_EVIDENCE_VARIANT1_STATE_COMPLETE),
			}}},
		},
	}
	m := &Model{
		snapshot: &v1.Snapshot{Tracking: &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{pr}}},
		reviews:  map[string]*v1.PullRequestDetails{},
	}

	return m, pr
}

func TestDeliverySummaryDistinguishesMergeIntentAndOutcome(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name, state, chain, lifecycle, condition string
		group                                    deliveryGroup
	}{
		{name: "automatic checks are ordinary progress", state: "waiting_checks", condition: "Waiting for checks", group: movingDeliveries},
		{name: "ready is not merged", state: "ready", condition: "Coordinator marked ready", group: movingDeliveries},
		{name: "request is not confirmation", state: "merging", condition: "Merge requested", group: movingDeliveries},
		{name: "uncertain outranks paused", state: "uncertain", chain: "paused", condition: "Merge outcome unknown", group: attentionDeliveries},
		{name: "cancel cannot erase an in-flight result", state: "merging", chain: "cancelled", condition: "Stopped; reconciliation pending", group: attentionDeliveries},
		{name: "stopped automation does not close the PR", state: "cancelled", chain: "cancelled", condition: "Automatic merge stopped", group: attentionDeliveries},
		{name: "paused is separate from entry progress", state: "waiting_checks", chain: "paused", condition: "Merge chain paused", group: attentionDeliveries},
		{name: "coordinator confirmed merge", state: "merged", condition: "Merge confirmed", group: settledDeliveries},
		{name: "GitHub confirms an uncertain operation", state: "uncertain", lifecycle: "merged", condition: "Merge confirmed", group: settledDeliveries},
		{name: "closed is not merged", state: "waiting", lifecycle: "closed", condition: "PR closed", group: settledDeliveries},
		{name: "unknown states stay explicit", state: "future-state", condition: "Merge state unavailable", group: attentionDeliveries},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			m, pr := deliveryFixture()
			m.snapshot.MergeStatuses = []*v1.MergeStatus{{PrId: pr.GetId(), State: tc.state, ChainState: tc.chain, AutoMerge: true}}

			if tc.lifecycle != "" {
				pr.Observation.Lifecycle = tc.lifecycle
			}

			got := m.deliverySummaries()[0]
			if got.group != tc.group || got.condition != tc.condition {
				t.Fatalf("got %q in group %d; want %q in group %d", got.condition, got.group, tc.condition, tc.group)
			}

			if got.group != settledDeliveries && got.tone == text.Success {
				t.Fatal("unfinished delivery was presented as confirmed success")
			}
		})
	}
}

func TestDeliverySummaryKeepsMissingAndStaleObservationsVisible(t *testing.T) {
	t.Parallel()

	m, pr := deliveryFixture()
	got := m.deliverySummaries()[0]

	if got.condition != "Monitoring PR" || got.group != movingDeliveries {
		t.Fatal("complete observations alone must not imply merge readiness")
	}

	pr.RefreshError = new("GitHub request timed out")
	got = m.deliverySummaries()[0]

	if got.condition != "Observation refresh failed" || got.observedAt != 1700000000000 || got.group != movingDeliveries {
		t.Fatal("transient refresh failure hid retained evidence or implied operator intervention")
	}

	pr.RefreshError = nil
	pr.Observation.Workflows = nil
	got = m.deliverySummaries()[0]

	if got.condition != "Readiness evidence incomplete" {
		t.Fatal("missing workflow coverage appeared complete")
	}

	pr.Observation = nil
	got = m.deliverySummaries()[0]

	if got.condition != "Awaiting first observation" || got.observedAt != 0 {
		t.Fatal("missing observations were filled with invented freshness or readiness")
	}

	pr.Enabled = false
	got = m.deliverySummaries()[0]

	if got.group != attentionDeliveries || got.condition != "Monitoring stopped" {
		t.Fatal("disabled monitoring looked like a scheduled observation")
	}
}

func TestDeliverySummaryDoesNotInferUnseenMergeAuthority(t *testing.T) {
	t.Parallel()

	cases := []struct {
		state, condition, next string
	}{
		{"waiting_checks", "Waiting for checks", "Inspect checks and saved merge authority; automatic merging is off"},
		{"ready", "Coordinator marked ready", "Inspect saved merge authority before dispatch; automatic merging is off"},
	}

	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			t.Parallel()

			m, pr := deliveryFixture()
			m.snapshot.MergeStatuses = []*v1.MergeStatus{{PrId: pr.GetId(), State: tc.state}}
			got := m.deliverySummaries()[0]

			if got.condition != tc.condition || got.next != tc.next || got.tone == text.Success {
				t.Fatalf("missing merge authority appeared to schedule an operation: %+v", got)
			}
		})
	}
}

func TestDeliverySummaryPreservesBlockersAlongsideOrdinaryProgress(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		mutate func(*Model, *v1.TrackedPullRequest)
	}{
		{"refresh failure", func(_ *Model, pr *v1.TrackedPullRequest) { pr.RefreshError = new("request timed out") }},
		{"working owner", func(m *Model, pr *v1.TrackedPullRequest) {
			m.snapshot.Tracking.Actions = []*v1.PendingAction{{PrId: pr.GetId(), State: v1.ActionState_ACTION_STATE_WORKING}}
		}},
		{"repair in progress", func(m *Model, pr *v1.TrackedPullRequest) {
			m.snapshot.Repairs = []*v1.RepairAttempt{{PrId: pr.GetId(), State: v1.RepairState_REPAIR_STATE_RUNNING}}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			m, pr := deliveryFixture()
			m.snapshot.MergeStatuses = []*v1.MergeStatus{{PrId: pr.GetId(), State: "blocked", Detail: "PR context changed since the merge notice"}}
			tc.mutate(m, pr)
			got := m.deliverySummaries()[0]

			if got.condition != "Merge blocked" || got.group != attentionDeliveries {
				t.Fatalf("ordinary progress obscured a retained blocker: %+v", got)
			}
		})
	}
}

func TestDeliverySummarySeparatesFeedbackReceiptFromResolution(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name, condition string
		action          v1.ActionState
		delivery        v1.DeliveryState
		receiptID       bool
		receipt         bool
		group           deliveryGroup
	}{
		{name: "pending", action: v1.ActionState_ACTION_STATE_OPEN, delivery: v1.DeliveryState_DELIVERY_STATE_PENDING, condition: "Feedback delivery pending", group: movingDeliveries},
		{name: "delivered without receipt", action: v1.ActionState_ACTION_STATE_OPEN, delivery: v1.DeliveryState_DELIVERY_STATE_DELIVERED, receiptID: true, condition: "Feedback delivered", group: movingDeliveries},
		{name: "receipt identifier unavailable", action: v1.ActionState_ACTION_STATE_OPEN, delivery: v1.DeliveryState_DELIVERY_STATE_DELIVERED, condition: "Feedback delivered; receipt unavailable", group: movingDeliveries},
		{name: "receipt is not resolution", action: v1.ActionState_ACTION_STATE_OPEN, delivery: v1.DeliveryState_DELIVERY_STATE_DELIVERED, receipt: true, condition: "Owner received feedback", group: movingDeliveries},
		{name: "owner acknowledgment is not resolution", action: v1.ActionState_ACTION_STATE_ACKNOWLEDGED, delivery: v1.DeliveryState_DELIVERY_STATE_DELIVERED, receipt: true, condition: "Owner acknowledged feedback", group: movingDeliveries},
		{name: "working owner supersedes old transport failure", action: v1.ActionState_ACTION_STATE_WORKING, delivery: v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE, condition: "Owner addressing feedback", group: movingDeliveries},
		{name: "uncertain needs reconciliation", action: v1.ActionState_ACTION_STATE_OPEN, delivery: v1.DeliveryState_DELIVERY_STATE_UNCERTAIN, condition: "Feedback delivery uncertain", group: attentionDeliveries},
		{name: "unavailable owner needs intervention", action: v1.ActionState_ACTION_STATE_OPEN, delivery: v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE, condition: "Owner delivery unavailable", group: attentionDeliveries},
		{name: "unknown action remains visible", action: v1.ActionState(99), delivery: v1.DeliveryState_DELIVERY_STATE_DELIVERED, condition: "Action state unavailable", group: attentionDeliveries},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			m, pr := deliveryFixture()
			m.snapshot.Tracking.Actions = []*v1.PendingAction{{Id: "feedback", PrId: pr.GetId(), OwnerAgentId: "owner", State: tc.action}}
			delivery := &v1.ActionDelivery{Id: "owner-delivery", ActionId: "feedback", RecipientAgentId: "owner", State: tc.delivery}
			m.snapshot.Tracking.Deliveries = []*v1.ActionDelivery{delivery}

			if tc.receiptID {
				delivery.MessageSequence = new(uint64(10))
			}

			if tc.receipt {
				delivery.AcknowledgedAtMs = new(int64(1000))
			}

			got := m.deliverySummaries()[0]
			if got.condition != tc.condition || got.group != tc.group {
				t.Fatalf("got %q in group %d; want %q in group %d", got.condition, got.group, tc.condition, tc.group)
			}
		})
	}
}

func TestDeliverySummaryUsesCurrentOwnerAndLatestDelivery(t *testing.T) {
	t.Parallel()

	m, pr := deliveryFixture()
	m.snapshot.Tracking.Actions = []*v1.PendingAction{{Id: "feedback", PrId: pr.GetId(), State: v1.ActionState_ACTION_STATE_OPEN}}
	m.snapshot.Tracking.Deliveries = []*v1.ActionDelivery{
		{Id: "observer", ActionId: "feedback", RecipientAgentId: "observer", State: v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE, UpdatedAtMs: 300},
		{Id: "old-owner-delivery", ActionId: "feedback", RecipientAgentId: "owner", State: v1.DeliveryState_DELIVERY_STATE_UNCERTAIN, UpdatedAtMs: 100},
		{Id: "new-owner-delivery", ActionId: "feedback", RecipientAgentId: "owner", State: v1.DeliveryState_DELIVERY_STATE_DELIVERED, UpdatedAtMs: 200, MessageSequence: new(uint64(10))},
	}

	got := m.deliverySummaries()[0]
	if got.condition != "Feedback delivered" || got.group != movingDeliveries {
		t.Fatal("observer or superseded delivery failure displaced the current owner delivery")
	}

	pr.Observation.Lifecycle = "merged"
	got = m.deliverySummaries()[0]

	if got.condition != "Merge confirmed" || got.group != settledDeliveries {
		t.Fatal("historical feedback kept a confirmed merge in the attention queue")
	}
}

func TestDeliverySummaryPreservesUncertainRepairsAndIgnoresSupersededFailures(t *testing.T) {
	t.Parallel()

	m, pr := deliveryFixture()
	repair := &v1.RepairAttempt{
		Id: "old-repair", PrId: pr.GetId(), UpdatedAtMs: 100,
		OriginalHead: new(strings.Repeat("b", 40)), State: v1.RepairState_REPAIR_STATE_FAILED,
	}
	m.snapshot.Repairs = []*v1.RepairAttempt{repair}

	if got := m.deliverySummaries()[0]; got.group == attentionDeliveries {
		t.Fatal("a failure for an earlier head displaced current PR progress")
	}

	repair.State = v1.RepairState_REPAIR_STATE_UNCERTAIN
	got := m.deliverySummaries()[0]

	if got.condition != "Repair outcome unknown" || got.group != attentionDeliveries {
		t.Fatal("a changed head erased uncertainty about an external repair effect")
	}

	repair.OriginalHead = new(pr.GetObservation().GetHeadSha())
	repair.State = v1.RepairState_REPAIR_STATE_AWAITING_CHECKS
	got = m.deliverySummaries()[0]

	if got.condition != "Repair awaiting checks" || got.group != movingDeliveries {
		t.Fatal("automatic repair verification was presented as operator work")
	}
}

func TestDeliverySummaryRejectsFailuresForSupersededRepairTargets(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name, targetRef, targetSHA string
	}{
		{"target advanced", "main", strings.Repeat("c", 40)},
		{"target branch changed", "release", strings.Repeat("b", 40)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			m, pr := deliveryFixture()
			repair := &v1.RepairAttempt{
				Id: "old-target", PrId: pr.GetId(), OriginalHead: new(pr.GetObservation().GetHeadSha()),
				TargetRef: new(tc.targetRef), TargetSha: new(tc.targetSHA), State: v1.RepairState_REPAIR_STATE_FAILED,
			}
			m.snapshot.Repairs = []*v1.RepairAttempt{repair}

			if got := m.deliverySummaries()[0]; got.condition != "Monitoring PR" {
				t.Fatalf("failure against a superseded target displaced current progress: %+v", got)
			}

			repair.State = v1.RepairState_REPAIR_STATE_UNCERTAIN

			if got := m.deliverySummaries()[0]; got.condition != "Repair outcome unknown" {
				t.Fatalf("target change erased an uncertain external effect: %+v", got)
			}
		})
	}
}

func TestDeliverySummariesRankInterventionsAndRetainIdentity(t *testing.T) {
	t.Parallel()

	m, pr := deliveryFixture()
	pr.Id, pr.Url = "waiting", "https://github.com/owner/repo/pull/3"
	m.snapshot.Tracking.Prs = append(m.snapshot.Tracking.Prs,
		&v1.TrackedPullRequest{Id: "merged", Url: "https://github.com/owner/repo/pull/4", Observation: &v1.TrackingObservation{Lifecycle: "merged"}},
		&v1.TrackedPullRequest{Id: "uncertain", Url: "https://github.com/owner/repo/pull/2", Enabled: true, OwnerAgentId: "owner"},
		&v1.TrackedPullRequest{Id: "paused", Url: "https://github.com/owner/repo/pull/1", Enabled: true, OwnerAgentId: "owner"},
		&v1.TrackedPullRequest{Id: "invalid", Url: "https://untrusted.example/owner/repo/pull/5"},
	)
	m.snapshot.MergeStatuses = []*v1.MergeStatus{
		{PrId: "uncertain", State: "uncertain"},
		{PrId: "paused", State: "waiting_checks", ChainState: "paused", AutoMerge: true},
	}
	m.snapshot.Jobs = []*v1.Job{{Id: "demo", Task: &v1.Task{Kind: &v1.Task_ResolveConflict{ResolveConflict: &v1.ResolveConflictTask{}}}}}
	m.reviews[pr.GetUrl()] = &v1.PullRequestDetails{Title: "Readable \x1b[31mchange\x1b[0m", ObservedAtMs: 1800000000000}

	summaries := m.deliverySummaries()
	ids := make([]string, 0, len(summaries))

	for _, summary := range summaries {
		ids = append(ids, summary.item.tracked.GetId())
	}

	if !slices.Equal(ids, []string{"uncertain", "paused", "waiting", "merged"}) {
		t.Fatalf("unexpected intervention order or non-PR item: %v", ids)
	}

	if summaries[2].title != "Readable change" || summaries[2].observedAt != 1700000000000 {
		t.Fatal("title or tracking freshness was replaced with unrelated cached data")
	}
}
