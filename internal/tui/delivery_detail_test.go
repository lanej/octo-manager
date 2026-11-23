package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func deliveryDetailModel(t *testing.T) (*Model, *v1.TrackedPullRequest) {
	t.Helper()

	m := model(t, theme.Dark)
	pr := &v1.TrackedPullRequest{
		Id: "delivery", Url: "https://github.com/owner/repository/pull/42", Enabled: true, OwnerAgentId: "owner",
		Observation: &v1.TrackingObservation{Id: 1, Lifecycle: "open", HeadSha: strings.Repeat("a", 40), ObservedAtMs: 1_000},
	}
	m.snapshot.Jobs = nil
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{pr}, Agents: []*v1.AgentReference{{Id: "owner", Target: &v1.AgentTarget{Harness: "pi", SessionId: "session", Label: new("Responsible worker")}}}}
	m.selected = pr.GetUrl()

	return m, pr
}

func TestDeliveryDetailKeepsDifferentRevisionAndPartialEvidenceVisible(t *testing.T) {
	t.Parallel()

	m, pr := deliveryDetailModel(t)
	pr.RefreshError = new("GitHub read timed out")
	pr.Observation.Checks = &v1.DomainCheckEvidence{Variant: &v1.DomainCheckEvidence_Variant_2{Variant_2: &v1.DomainCheckEvidenceVariant2{
		State: new(v1.DomainCheckEvidenceVariant2State_DOMAIN_CHECK_EVIDENCE_VARIANT2_STATE_PARTIAL), Reason: new("pagination incomplete"),
		Value: &v1.DomainCheckEvidenceVariant2Value{Items: []*v1.DomainCheckEvidenceVariant2ValueItem{
			{Name: new("current check"), HeadSha: new(pr.Observation.HeadSha), Conclusion: new("success")},
			{Name: new("old check"), HeadSha: new(strings.Repeat("b", 40)), Conclusion: new("success")},
			{Name: new("unpinned check"), Conclusion: new("success")},
		}},
	}}}
	m.reviews[pr.GetUrl()] = &v1.PullRequestDetails{Title: "Change description", HeadSha: strings.Repeat("b", 40), ObservedAtMs: 500, MayHaveMoreMessages: true}

	content := inspectionText(m.deliveryDetailContent(80))
	for _, want := range []string{"Tracked head aaaaaaaa", "partial (pagination incomplete)", "1 passed", "1 different head", "1 unpinned", "Review-cache head bbbbbbbb", "Different revision", "Partial review history", "Previous observation retained", "GitHub read timed out"} {
		if !strings.Contains(content, want) {
			t.Errorf("missing consequential evidence %q in:\n%s", want, content)
		}
	}

	if strings.Contains(content, "2 passed") || strings.Contains(content, "independent review passed") {
		t.Fatal("detail promoted old or unavailable evidence into a current pass")
	}
}

func TestDeliveryDetailSeparatesReceiptFromActionDisposition(t *testing.T) {
	t.Parallel()

	m, pr := deliveryDetailModel(t)
	action := &v1.PendingAction{
		Id: "review", PrId: pr.GetId(), OwnerAgentId: "owner", State: v1.ActionState_ACTION_STATE_OPEN, CreatedAtMs: 2_000,
		Summary: "Make following explicit", EvidenceUrl: pr.GetUrl() + "#discussion_r1",
		Blocker: &v1.PendingAction_ReviewFeedback{ReviewFeedback: &v1.ReviewFeedback{Author: "josh", Source: "inline", HeadSha: new(strings.Repeat("b", 40))}},
	}
	delivery := &v1.ActionDelivery{ActionId: action.GetId(), RecipientAgentId: "owner", State: v1.DeliveryState_DELIVERY_STATE_DELIVERED, MessageSequence: new(uint64(1))}
	m.snapshot.Tracking.Actions = []*v1.PendingAction{action}
	m.snapshot.Tracking.Deliveries = []*v1.ActionDelivery{delivery}

	content := inspectionText(m.deliveryDetailContent(80))
	for _, want := range []string{"Transport delivered", "Recipient receipt Not confirmed", "Owner disposition open", "Reviewed head bbbbbbbb", "josh · inline"} {
		if !strings.Contains(content, want) {
			t.Errorf("missing separate feedback state %q", want)
		}
	}

	delivery.AcknowledgedAtMs = new(int64(3_000))
	content = inspectionText(m.deliveryDetailContent(80))

	if !strings.Contains(content, "Recipient receipt Received") || !strings.Contains(content, "Owner disposition open") || action.GetState() != v1.ActionState_ACTION_STATE_OPEN {
		t.Fatal("recording a transport receipt implicitly resolved the owner's action")
	}

	pr.Observation.Lifecycle = "merged"
	content = inspectionText(m.deliveryDetailContent(80))

	if !strings.Contains(content, "Retained as history") || !strings.Contains(content, "Owner disposition open") {
		t.Fatal("merge changed retained action evidence instead of rendering it as history")
	}
}

func TestDeliveryDetailDoesNotTreatAutomaticMergeAsConfirmation(t *testing.T) {
	t.Parallel()

	m, pr := deliveryDetailModel(t)
	merge := &v1.MergeStatus{PrId: pr.GetId(), AutoMerge: true, AutoMergeSource: "inherited", State: "waiting_checks", ChainState: "paused", Detail: "A required check is still running"}
	m.snapshot.MergeStatuses = []*v1.MergeStatus{merge}

	content := inspectionText(m.deliveryDetailContent(80))
	for _, want := range []string{"Automatic merging ON", "inherited", "Chain paused", "waiting checks", "No merge confirmation"} {
		if !strings.Contains(content, want) {
			t.Errorf("merge setting hid %q", want)
		}
	}

	merge.State = "ready"
	content = inspectionText(m.deliveryDetailContent(80))

	if !strings.Contains(content, "Coordinator progress ready") || !strings.Contains(content, "No merge confirmation") {
		t.Fatal("coordinator readiness was promoted into a merge result")
	}

	merge.State = "uncertain"
	content = inspectionText(m.deliveryDetailContent(80))

	if !strings.Contains(content, "reconcile the existing operation before another attempt") || strings.Contains(content, "confirmed merge") {
		t.Fatal("uncertain merge was presented as settled or safe to retry")
	}

	merge.State = "merged"
	content = inspectionText(m.deliveryDetailContent(80))

	if !strings.Contains(content, "Coordinator confirmed merge") {
		t.Fatal("confirmed merge result is unavailable")
	}
}

func TestDeliveryDetailMissingEvidenceAndNarrowWidths(t *testing.T) {
	t.Parallel()

	m, pr := deliveryDetailModel(t)
	pr.Observation = nil
	m.reviews[pr.GetUrl()] = &v1.PullRequestDetails{Title: "Description\x1b[2J" + strings.Repeat("long-title-", 30), HeadSha: strings.Repeat("b", 40)}

	for _, width := range []int{132, 80, 40, 24, 12, 1} {
		for _, content := range []string{m.deliveryDetailContent(width), m.attentionPreview(width)} {
			for _, line := range strings.Split(content, "\n") {
				if ansi.StringWidth(line) > width {
					t.Fatalf("detail exceeds %d columns: %q", width, line)
				}
			}

			if strings.Contains(content, "\x1b[2J") {
				t.Fatal("untrusted terminal control reached the detail renderer")
			}
		}
	}

	content := inspectionText(m.deliveryDetailContent(80))
	if !strings.Contains(content, "Readiness is unknown") || !strings.Contains(content, "GitHub observed unavailable") || strings.Contains(content, "1970") {
		t.Fatal("missing observation was turned into a readiness result or epoch timestamp")
	}

	if !strings.Contains(content, "Review-cache head bbbbbbbb") || strings.Contains(content, "Different revision") {
		t.Fatal("unknown tracking head was treated as a known revision difference")
	}
}

func inspectionText(content string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(ansi.Strip(content), ": ", " ")), " ")
}
