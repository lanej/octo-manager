package tui

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func (m *Model) attentionPreview(width int) string {
	return m.deliveryPreview(m.currentSubject(), width)
}

func (m *Model) deliveryRecordSummary(summary deliverySummary, inventory bool) layout.RecordSummary {
	record := layout.RecordSummary{
		Title:  m.link(summary.item.url),
		Status: text.Pill(summary.condition, summary.tone, m.theme, text.Normal),
		Next:   &layout.Pair{Label: "Next", Value: summary.next},
	}
	if summary.title != summary.item.label {
		record.Subtitle = text.Label(safe(summary.title), m.theme)
	}

	if inventory {
		record.Fields = []layout.Pair{{Label: "Observed", Value: m.deliveryObservedAt(summary.observedAt)}}
	}

	return record
}

func (m *Model) deliveryPreview(item subject, width int) string {
	return m.deliveryPreviewDocument(item).View(width, m.theme)
}

func (m *Model) deliveryPreviewDocument(item subject) layout.DetailDocument {
	if item.url == "" {
		return layout.DetailDocument{Sections: []layout.DetailSection{{ID: "empty", Paragraphs: []string{"Select a delivery to inspect its next step."}}}}
	}

	document := layout.DetailDocument{Summary: m.deliveryRecordSummary(m.summarizeDelivery(item), false)}
	if pr := item.tracked; pr != nil {
		document.Sections = append(document.Sections, layout.DetailSection{
			ID: "observation", Title: "Observation", FullWidth: true,
			Fields: []layout.Pair{
				{Label: "Owner", Value: m.agentLabel(pr.GetOwnerAgentId())},
				{Label: "Observed", Value: m.deliveryObservedAt(pr.GetObservation().GetObservedAtMs())},
			},
		})
		if pr.GetRefreshError() != "" {
			document.Sections = append(document.Sections, layout.DetailSection{
				ID: "refresh", Title: "Refresh failed", FullWidth: true,
				Paragraphs: []string{pr.GetRefreshError(), "Previous observation retained."},
			})
		}
	}

	document.Sections = append(document.Sections, layout.DetailSection{
		ID: "navigation", FullWidth: true,
		Paragraphs: []string{"Enter delivery details · o GitHub review"},
	})

	return document
}

func (m *Model) deliveryDetailContent(width int) string {
	return m.deliveryDetail(m.currentSubject(), width)
}

func (m *Model) deliveryDetail(item subject, width int) string {
	return m.deliveryDocument(item).View(width, m.theme)
}

func (m *Model) deliveryDocument(item subject) layout.DetailDocument {
	if item.url == "" {
		return layout.DetailDocument{Sections: []layout.DetailSection{{
			ID: "empty", Paragraphs: []string{"Select a GitHub delivery. Local worker runs are available in diagnostics."},
		}}}
	}

	document := layout.DetailDocument{Summary: m.deliveryRecordSummary(m.summarizeDelivery(item), false)}

	pr := item.tracked
	if pr == nil {
		document.Sections = []layout.DetailSection{{
			ID: "tracking", Title: "Tracking", FullWidth: true,
			Paragraphs: []string{"This PR is not enrolled for tracking; delivery gates and ownership are unavailable."},
		}}

		return document
	}

	document.Sections = []layout.DetailSection{m.deliveryIdentitySection(pr), m.deliveryEvidenceSection(pr), m.deliveryMergeSection(pr)}
	document.Sections = append(document.Sections, m.deliveryFeedbackSections(pr)...)

	return document
}

func wrapDeliveryContent(content string, width int) string {
	return ansi.Hardwrap(ansi.Wrap(content, max(1, width), " "), max(1, width), true)
}

func (m *Model) deliveryIdentitySection(pr *v1.TrackedPullRequest) layout.DetailSection {
	o := pr.GetObservation()

	section := layout.DetailSection{
		ID: "identity", Title: "Identity & observation",
		Fields: []layout.Pair{
			{Label: "Owner", Value: m.agentLabel(pr.GetOwnerAgentId())},
			{Label: "Tracked head", Value: deliveryRevision(o.GetHeadSha())},
			{Label: "GitHub observed", Value: m.deliveryObservedAt(o.GetObservedAtMs())},
		},
	}
	if target := o.GetTargetBase(); target != nil {
		section.Fields = append(section.Fields, layout.Pair{Label: "Target", Value: target.GetRef() + " · " + deliveryRevision(target.GetSha())})
	}

	if pr.GetRefreshError() != "" {
		section.Fields = append(section.Fields, layout.Pair{Label: "Refresh failed", Value: pr.GetRefreshError()})
		section.Paragraphs = append(section.Paragraphs, "Previous observation retained; current GitHub state is unconfirmed.")
	}

	if details := m.reviews[pr.GetUrl()]; details != nil {
		section.Fields = append(section.Fields, layout.Pair{Label: "Review cache", Value: m.deliveryObservedAt(details.GetObservedAtMs())})
		if details.GetHeadSha() != "" && o.GetHeadSha() != "" && details.GetHeadSha() != o.GetHeadSha() {
			section.Fields = append(section.Fields, layout.Pair{Label: "Review-cache head", Value: deliveryRevision(details.GetHeadSha())})
			section.Statuses = append(section.Statuses, layout.StatusItem{Label: "Review evidence", Value: text.Pill("Different revision", text.Warning, m.theme, text.Normal), Detail: "These sources cover different revisions; refresh before assessing readiness."})
		} else {
			section.Fields = append(section.Fields, layout.Pair{Label: "Review-cache head", Value: deliveryRevision(details.GetHeadSha())})
		}

		if details.GetMayHaveMoreMessages() {
			section.Paragraphs = append(section.Paragraphs, "Partial review history; more messages may exist on GitHub.")
		}
	}

	return section
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

func (m *Model) deliveryEvidenceSection(pr *v1.TrackedPullRequest) layout.DetailSection {
	section := layout.DetailSection{ID: "readiness", Title: "Readiness evidence"}

	o := pr.GetObservation()
	if o == nil {
		section.Paragraphs = []string{"No stored GitHub observation. Readiness is unknown."}
		return section
	}

	section.Statuses = []layout.StatusItem{
		{Label: "Checks", Value: text.Label(safe(deliveryCheckEvidence(o.GetChecks(), o.GetHeadSha())), m.theme)},
		{Label: "Workflows", Value: text.Label(safe(deliveryCheckEvidence(o.GetWorkflows(), o.GetHeadSha())), m.theme)},
		{Label: "GitHub reviews", Value: text.Label(safe(deliveryReviewEvidence(o.GetReviews(), o.GetHeadSha())), m.theme)},
		{Label: "Feedback coverage", Value: text.Label(safe(observationStatus(o.GetFeedback())), m.theme)},
		{Label: "Owner actions", Value: text.Label(counted(m.openActions(pr.GetId()), "outstanding action"), m.theme)},
	}
	if o.GetMergeability() != "" {
		section.Statuses = append(section.Statuses, layout.StatusItem{Label: "Mergeability", Value: text.Label(safe(o.GetMergeability()), m.theme)})
	}

	section.Paragraphs = []string{"Evidence coverage is separate from passing required merge gates."}

	return section
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

func (m *Model) deliveryMergeSection(pr *v1.TrackedPullRequest) layout.DetailSection {
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

	section := layout.DetailSection{
		ID: "merge", Title: "Merge authority & result", FullWidth: true,
		Fields: []layout.Pair{{Label: "Auto-merge setting", Value: authority}},
	}
	if merge != nil {
		section.Fields = append(section.Fields, layout.Pair{Label: "Coordinator progress", Value: strings.ReplaceAll(merge.GetState(), "_", " ")})
		if merge.GetChainState() != "" {
			section.Fields = append(section.Fields, layout.Pair{Label: "Chain", Value: merge.GetChainState()})
		}

		if merge.GetDetail() != "" {
			section.Fields = append(section.Fields, layout.Pair{Label: "Gate", Value: merge.GetDetail()})
		}

		if len(merge.GetPrerequisiteUrls()) > 0 {
			section.Body = m.detailLinks("Requires merge", merge.GetPrerequisiteUrls()...)
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

	section.Statuses = append(section.Statuses, layout.StatusItem{Label: "Merge result", Value: text.Label(result, m.theme)})
	section.Paragraphs = []string{"An enabled switch does not establish readiness or confirm a merge."}

	return section
}

func (m *Model) deliveryFeedbackSections(pr *v1.TrackedPullRequest) []layout.DetailSection {
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
		return []layout.DetailSection{{
			ID: "feedback", Title: "Feedback route", FullWidth: true,
			Paragraphs: []string{"No retained review actions for this PR.", "Open GitHub for its original review conversation."},
		}}
	}

	sections := []layout.DetailSection{}
	for _, action := range actions[:min(4, len(actions))] {
		sections = append(sections, m.deliveryFeedbackSection(pr, action))
		for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
			if delivery.GetActionId() == action.GetId() {
				sections = append(sections, m.deliveryRecipientSection(action.GetId(), delivery))
			}
		}
	}

	limit := layout.DetailSection{
		ID: "feedback-limits", Title: "Feedback interpretation", FullWidth: true,
		Paragraphs: []string{"Transport delivery, recipient receipt, and owner disposition are separate."},
	}
	if len(actions) > 4 {
		limit.Paragraphs = append(limit.Paragraphs, fmt.Sprintf("%d additional review actions are available in Tracking diagnostics.", len(actions)-4))
	}

	return append(sections, limit)
}

func (m *Model) deliveryFeedbackSection(pr *v1.TrackedPullRequest, action *v1.PendingAction) layout.DetailSection {
	section := layout.DetailSection{ID: "feedback:" + action.GetId(), Title: "Feedback · " + action.GetSummary(), FullWidth: true}
	if feedback := action.GetReviewFeedback(); feedback != nil {
		section.Fields = append(section.Fields, layout.Pair{Label: "Source", Value: feedback.GetAuthor() + " · " + feedback.GetSource()}, layout.Pair{Label: "Reviewed head", Value: deliveryRevision(feedback.GetHeadSha())})
		if feedback.GetHeadSha() != "" && pr.GetObservation().GetHeadSha() != "" && feedback.GetHeadSha() != pr.GetObservation().GetHeadSha() {
			section.Paragraphs = append(section.Paragraphs, "Feedback references a different revision.")
		}
	} else if review := action.GetChangesRequested(); review != nil {
		section.Fields = append(section.Fields, layout.Pair{Label: "Source", Value: review.GetReviewer() + " · changes requested"}, layout.Pair{Label: "Reviewed head", Value: deliveryRevision(review.GetReviewedHeadSha())})
		if review.GetReviewedHeadSha() != "" && pr.GetObservation().GetHeadSha() != "" && review.GetReviewedHeadSha() != pr.GetObservation().GetHeadSha() {
			section.Paragraphs = append(section.Paragraphs, "Review references a different revision.")
		}
	}

	section.Fields = append(section.Fields, layout.Pair{Label: "Observed", Value: m.deliveryObservedAt(action.GetCreatedAtMs())}, layout.Pair{Label: "Owner", Value: m.agentLabel(action.GetOwnerAgentId())})
	delivered := false

	for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
		if delivery.GetActionId() == action.GetId() {
			delivered = true
			break
		}
	}

	if !delivered {
		section.Paragraphs = append(section.Paragraphs, "No transport delivery recorded.")
	}

	section.Statuses = []layout.StatusItem{{Label: "Owner disposition", Value: text.Pill(stateName(action.GetState().String(), "ACTION_STATE_"), actionTone(action.GetState()), m.theme, text.Normal)}}
	if actionHistorical(action, pr) {
		section.Paragraphs = append(section.Paragraphs, "Retained as history; the recorded disposition is unchanged.")
	}

	if action.GetCloseReason() != "" {
		section.Fields = append(section.Fields, layout.Pair{Label: "Disposition reason", Value: action.GetCloseReason()})
	}

	if action.GetEvidenceUrl() != "" {
		section.Body = m.detailLinks("Original", action.GetEvidenceUrl())
	}

	return section
}

func (m *Model) deliveryRecipientSection(actionID string, delivery *v1.ActionDelivery) layout.DetailSection {
	id := delivery.GetId()
	if id == "" {
		id = delivery.GetRecipientAgentId()
	}

	section := layout.DetailSection{
		ID: "feedback:" + actionID + ":recipient:" + id, Title: "Delivery to " + m.agentLabel(delivery.GetRecipientAgentId()),
		Fields:   []layout.Pair{{Label: "Recipient", Value: m.agentLabel(delivery.GetRecipientAgentId())}},
		Statuses: []layout.StatusItem{{Label: "Transport", Value: text.Pill(stateName(delivery.GetState().String(), "DELIVERY_STATE_"), deliveryTone(delivery.GetState()), m.theme, text.Normal)}},
	}

	receipt := "Not confirmed"
	if delivery.AcknowledgedAtMs != nil {
		receipt = "Received " + m.deliveryObservedAt(delivery.GetAcknowledgedAtMs())
	} else if delivery.MessageSequence == nil {
		receipt = "Unavailable; no receipt identifier recorded"
	}

	section.Statuses = append(section.Statuses, layout.StatusItem{Label: "Recipient receipt", Value: text.Label(receipt, m.theme)})
	if delivery.GetState() == v1.DeliveryState_DELIVERY_STATE_UNCERTAIN || delivery.GetState() == v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE {
		if reason := strings.TrimSpace(m.deliveryDetails(delivery.GetProgress())); reason != "" {
			section.Fields = append(section.Fields, layout.Pair{Label: "Transport detail", Value: reason})
		}
	}

	return section
}

// Links use native composition while the document owns field and section layout.
func (m *Model) detailLinks(label string, addresses ...string) func(int) string {
	group := layout.LinkGroup{}
	unavailable := false

	for _, address := range addresses {
		link, err := webLink(address)
		if err != nil {
			unavailable = true
			continue
		}

		link.Label = label + " · " + link.Label
		group.Links = append(group.Links, link)
	}

	t := m.theme

	return func(width int) string {
		view, err := group.View(width, t)
		if err != nil {
			view, err = group.Plain()
			if err != nil {
				return wrapDeliveryContent(t.Subtle().Render("Link unavailable"), width)
			}
		}

		if unavailable {
			view = layout.Column(view, t.Subtle().Render("Link unavailable"))
		}

		return wrapDeliveryContent(view, width)
	}
}
