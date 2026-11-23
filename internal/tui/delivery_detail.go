package tui

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func (m *Model) attentionPreview(width int) string {
	return m.deliveryPreview(m.currentSubject(), width)
}

func (m *Model) deliveryPreview(item subject, width int) string {
	if item.url == "" {
		return wrapDeliveryContent(m.muted("Select a delivery to inspect its next step."), width)
	}

	summary := m.summarizeDelivery(item)
	lines := []string{
		text.Label(safe(summary.title), m.theme),
		m.link(item.url),
		"",
		text.Pill(summary.condition, summary.tone, m.theme, text.Normal),
		m.field("Next", summary.next),
	}

	if pr := item.tracked; pr != nil {
		lines = append(lines, "", m.field("Owner", m.agentLabel(pr.GetOwnerAgentId())), m.field("Observed", m.deliveryObservedAt(pr.GetObservation().GetObservedAtMs())))
		if pr.GetRefreshError() != "" {
			lines = append(lines, m.field("Refresh failed", pr.GetRefreshError()), m.muted("Previous observation retained."))
		}
	}

	lines = append(lines, "", text.KeyHint("enter", "delivery details", m.theme)+" · "+text.KeyHint("o", "GitHub review", m.theme))

	return wrapDeliveryContent(strings.Join(lines, "\n"), width)
}

func (m *Model) deliveryDetailContent(width int) string {
	return m.deliveryDetail(m.currentSubject(), width)
}

func (m *Model) deliveryDetail(item subject, width int) string {
	if item.url == "" {
		return wrapDeliveryContent(m.muted("Select a GitHub delivery. Local worker runs are available in diagnostics."), width)
	}

	summary := m.summarizeDelivery(item)
	lines := []string{text.Label(safe(summary.title), m.theme), m.link(item.url), "", text.Pill(summary.condition, summary.tone, m.theme, text.Normal), m.field("Next", summary.next)}
	pr := item.tracked

	if pr == nil {
		lines = append(lines, "", m.muted("This PR is not enrolled for tracking; delivery gates and ownership are unavailable."))

		return wrapDeliveryContent(strings.Join(lines, "\n"), width)
	}

	lines = append(lines, "", m.deliveryIdentity(pr), "")
	readiness := m.deliveryEvidence(pr) + "\n\n" + m.deliveryMergeEvidence(pr)
	feedback := m.deliveryFeedbackTrail(pr)

	if width < 32 {
		lines = append(lines, "READINESS & MERGE", readiness, "", "FEEDBACK ROUTE", feedback)
	} else {
		lines = append(lines, m.sections("delivery-details", width,
			dashboardSection{id: "delivery-evidence", title: "READINESS & MERGE", content: func(int) string { return readiness }},
			dashboardSection{id: "delivery-feedback", title: "FEEDBACK ROUTE", content: func(int) string { return feedback }},
		))
	}

	return wrapDeliveryContent(strings.Join(lines, "\n"), width)
}

func wrapDeliveryContent(content string, width int) string {
	return ansi.Hardwrap(ansi.Wrap(content, max(1, width), " "), max(1, width), true)
}

func (m *Model) deliveryIdentity(pr *v1.TrackedPullRequest) string {
	o := pr.GetObservation()
	lines := []string{
		m.field("Owner", m.agentLabel(pr.GetOwnerAgentId())),
		m.field("Tracked head", deliveryRevision(o.GetHeadSha())),
		m.field("GitHub observed", m.deliveryObservedAt(o.GetObservedAtMs())),
	}

	if target := o.GetTargetBase(); target != nil {
		lines = append(lines, m.field("Target", target.GetRef()+" · "+deliveryRevision(target.GetSha())))
	}

	if pr.GetRefreshError() != "" {
		lines = append(lines, m.field("Refresh failed", pr.GetRefreshError()), m.muted("Previous observation retained; current GitHub state is unconfirmed."))
	}

	if details := m.reviews[pr.GetUrl()]; details != nil {
		lines = append(lines, m.field("Review cache", m.deliveryObservedAt(details.GetObservedAtMs())))
		if details.GetHeadSha() != "" && o.GetHeadSha() != "" && details.GetHeadSha() != o.GetHeadSha() {
			lines = append(lines, m.field("Different review-cache head", deliveryRevision(details.GetHeadSha())), m.muted("These sources cover different revisions; refresh before assessing readiness."))
		} else {
			lines = append(lines, m.field("Review-cache head", deliveryRevision(details.GetHeadSha())))
		}

		if details.GetMayHaveMoreMessages() {
			lines = append(lines, m.muted("Partial review history; more messages may exist on GitHub."))
		}
	}

	return strings.Join(lines, "\n")
}

func deliveryRevision(head string) string {
	if head == "" {
		return "unavailable"
	}

	return shortSHA(head)
}

func (m *Model) deliveryObservedAt(at int64) string {
	if at == 0 {
		return "unavailable"
	}

	return m.timestamp(at, fullTimestamp)
}

func (m *Model) deliveryEvidence(pr *v1.TrackedPullRequest) string {
	o := pr.GetObservation()
	if o == nil {
		return m.muted("No stored GitHub observation. Readiness is unknown.")
	}

	lines := []string{
		m.field("Checks", deliveryCheckEvidence(o.GetChecks(), o.GetHeadSha())),
		m.field("Workflows", deliveryCheckEvidence(o.GetWorkflows(), o.GetHeadSha())),
		m.field("GitHub reviews", deliveryReviewEvidence(o.GetReviews(), o.GetHeadSha())),
		m.field("Feedback coverage", observationStatus(o.GetFeedback())),
		m.field("Owner actions", counted(m.openActions(pr.GetId()), "outstanding action")),
	}
	if o.GetMergeability() != "" {
		lines = append(lines, m.field("Mergeability", o.GetMergeability()))
	}

	lines = append(lines, m.muted("Evidence coverage is separate from passing required merge gates."))

	return strings.Join(lines, "\n")
}

type deliveryCheckEvidenceCounts struct {
	passed, failed, pending, neutral, unknown, otherHead, unpinned int
}

func (c *deliveryCheckEvidenceCounts) add(head, status, conclusion, trackedHead string) {
	if head == "" || trackedHead == "" {
		c.unpinned++

		return
	}

	if head != trackedHead {
		c.otherHead++

		return
	}

	switch strings.ToLower(conclusion) {
	case "success":
		c.passed++
	case "failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error":
		c.failed++
	case "neutral", "skipped":
		c.neutral++
	default:
		switch strings.ToLower(status) {
		case "queued", "in_progress", "pending", "requested", "waiting":
			c.pending++
		default:
			c.unknown++
		}
	}
}

func deliveryCheckEvidence(evidence *v1.DomainCheckEvidence, head string) string {
	counts := deliveryCheckEvidenceCounts{}
	for _, check := range evidence.GetVariant_1().GetValue().GetItems() {
		counts.add(check.GetHeadSha(), check.GetStatus(), check.GetConclusion(), head)
	}

	for _, check := range evidence.GetVariant_2().GetValue().GetItems() {
		counts.add(check.GetHeadSha(), check.GetStatus(), check.GetConclusion(), head)
	}

	parts := []string{observationStatus(evidence)}

	for _, count := range []struct {
		value int
		label string
	}{{counts.passed, "passed"}, {counts.failed, "failed"}, {counts.pending, "pending"}, {counts.neutral, "neutral/skipped"}, {counts.unknown, "unknown result"}, {counts.otherHead, "different head"}, {counts.unpinned, "unpinned"}} {
		if count.value > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", count.value, count.label))
		}
	}

	return strings.Join(parts, " · ")
}

func deliveryReviewEvidence(evidence *v1.DomainReviewEvidence, head string) string {
	current, different, unpinned := 0, 0, 0
	add := func(reviewedHead string) {
		switch {
		case reviewedHead == "" || head == "":
			unpinned++
		case reviewedHead != head:
			different++
		default:
			current++
		}
	}

	for _, review := range evidence.GetVariant_1().GetValue().GetItems() {
		add(review.GetHeadSha())
	}

	for _, review := range evidence.GetVariant_2().GetValue().GetItems() {
		add(review.GetHeadSha())
	}

	parts := []string{observationStatus(evidence)}
	if current > 0 {
		parts = append(parts, fmt.Sprintf("%d at tracked head", current))
	}

	if different > 0 {
		parts = append(parts, fmt.Sprintf("%d at different head", different))
	}

	if unpinned > 0 {
		parts = append(parts, fmt.Sprintf("%d unpinned", unpinned))
	}

	return strings.Join(parts, " · ")
}

func (m *Model) deliveryMergeEvidence(pr *v1.TrackedPullRequest) string {
	merge := m.mergeStatus(pr.GetId())
	authority := "Automatic merging not configured"

	if merge != nil {
		authority = "Automatic merging OFF"
		if merge.GetAutoMerge() {
			authority = "Automatic merging ON"
		}

		if merge.GetAutoMergeSource() != "" {
			authority += " · " + merge.GetAutoMergeSource()
		}

		if merge.GetAutoMergeStage() != "" {
			authority += " (" + merge.GetAutoMergeStage() + ")"
		}
	}

	lines := []string{m.field("Auto-merge setting", authority)}
	if merge != nil {
		lines = append(lines, m.field("Coordinator progress", strings.ReplaceAll(merge.GetState(), "_", " ")))
		if merge.GetChainState() != "" {
			lines = append(lines, m.field("Chain", merge.GetChainState()))
		}

		if merge.GetDetail() != "" {
			lines = append(lines, m.field("Gate", merge.GetDetail()))
		}

		for _, address := range merge.GetPrerequisiteUrls() {
			lines = append(lines, m.muted("Requires merge: ")+m.link(address))
		}
	}

	result := "No merge confirmation in the stored snapshot"

	switch {
	case merge.GetState() == "merged":
		result = "Coordinator confirmed merge"
	case pr.GetObservation().GetLifecycle() == "merged":
		result = "GitHub observed merged"
	case merge.GetState() == "uncertain":
		result = "Unknown; reconcile the existing operation before another attempt"
	case pr.GetObservation().GetLifecycle() == "closed":
		result = "Closed; no merge confirmation in the stored snapshot"
	}

	lines = append(lines, m.field("Merge result", result), m.muted("An enabled switch does not establish readiness or confirm a merge."))

	return strings.Join(lines, "\n")
}

func (m *Model) deliveryFeedbackTrail(pr *v1.TrackedPullRequest) string {
	actions := []*v1.PendingAction{}

	for _, action := range m.snapshot.GetTracking().GetActions() {
		if action.GetPrId() == pr.GetId() && (action.GetReviewFeedback() != nil || action.GetChangesRequested() != nil) {
			actions = append(actions, action)
		}
	}

	sort.SliceStable(actions, func(i, j int) bool {
		left, right := actionHistorical(actions[i], pr), actionHistorical(actions[j], pr)
		if left != right {
			return !left
		}

		return actions[i].GetUpdatedAtMs() > actions[j].GetUpdatedAtMs()
	})

	if len(actions) == 0 {
		return m.muted("No retained review actions for this PR.\nOpen GitHub for its original review conversation.")
	}

	parts := []string{}
	for _, action := range actions[:min(4, len(actions))] {
		parts = append(parts, m.deliveryFeedbackAction(pr, action))
	}

	if len(actions) > 4 {
		parts = append(parts, m.muted(fmt.Sprintf("%d additional review actions are available in Tracking diagnostics.", len(actions)-4)))
	}

	parts = append(parts, m.muted("Transport delivery, recipient receipt, and owner disposition are separate."))

	return strings.Join(parts, "\n\n")
}

func (m *Model) deliveryFeedbackAction(pr *v1.TrackedPullRequest, action *v1.PendingAction) string {
	lines := []string{text.Label(safe(action.GetSummary()), m.theme)}
	if feedback := action.GetReviewFeedback(); feedback != nil {
		lines = append(lines, m.field("Source", feedback.GetAuthor()+" · "+feedback.GetSource()), m.field("Reviewed head", deliveryRevision(feedback.GetHeadSha())))
		if feedback.GetHeadSha() != "" && pr.GetObservation().GetHeadSha() != "" && feedback.GetHeadSha() != pr.GetObservation().GetHeadSha() {
			lines = append(lines, m.muted("Feedback references a different revision."))
		}
	} else if review := action.GetChangesRequested(); review != nil {
		lines = append(lines, m.field("Source", review.GetReviewer()+" · changes requested"), m.field("Reviewed head", deliveryRevision(review.GetReviewedHeadSha())))
		if review.GetReviewedHeadSha() != "" && pr.GetObservation().GetHeadSha() != "" && review.GetReviewedHeadSha() != pr.GetObservation().GetHeadSha() {
			lines = append(lines, m.muted("Review references a different revision."))
		}
	}

	lines = append(lines, m.field("Observed", m.deliveryObservedAt(action.GetCreatedAtMs())), m.field("Owner", m.agentLabel(action.GetOwnerAgentId())))
	delivered := false

	for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
		if delivery.GetActionId() == action.GetId() {
			delivered = true

			lines = append(lines, m.deliveryRecipientTrail(delivery))
		}
	}

	if !delivered {
		lines = append(lines, m.muted("No transport delivery recorded."))
	}

	lines = append(lines, m.field("Owner disposition", stateName(action.GetState().String(), "ACTION_STATE_")))
	if actionHistorical(action, pr) {
		lines = append(lines, m.muted("Retained as history; the recorded disposition is unchanged."))
	}

	if action.GetCloseReason() != "" {
		lines = append(lines, m.field("Disposition reason", action.GetCloseReason()))
	}

	if action.GetEvidenceUrl() != "" {
		lines = append(lines, m.muted("Original: ")+m.link(action.GetEvidenceUrl()))
	}

	return strings.Join(lines, "\n")
}

func (m *Model) deliveryRecipientTrail(delivery *v1.ActionDelivery) string {
	lines := []string{m.field("Recipient", m.agentLabel(delivery.GetRecipientAgentId())), m.field("Transport", stateName(delivery.GetState().String(), "DELIVERY_STATE_"))}
	receipt := "Not confirmed"

	if delivery.AcknowledgedAtMs != nil {
		receipt = "Received " + m.deliveryObservedAt(delivery.GetAcknowledgedAtMs())
	} else if delivery.MessageSequence == nil {
		receipt = "Unavailable; no receipt identifier recorded"
	}

	lines = append(lines, m.field("Recipient receipt", receipt))
	if delivery.GetState() == v1.DeliveryState_DELIVERY_STATE_UNCERTAIN || delivery.GetState() == v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE {
		if reason := strings.TrimSpace(m.deliveryDetails(delivery.GetProgress())); reason != "" {
			lines = append(lines, m.field("Transport detail", reason))
		}
	}

	return strings.Join(lines, "\n")
}
