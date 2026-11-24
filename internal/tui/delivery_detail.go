package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func (m *Model) deliveryRecordSummary(summary deliverySummary, inventory bool) layout.RecordSummary {
	record := layout.RecordSummary{
		Title:  m.link(summary.item.url),
		Status: text.Pill(summary.condition, summary.tone, m.theme, text.Normal),
	}
	if summary.title != summary.item.label {
		record.Subtitle = text.Label(safe(summary.title), m.theme)
	}

	if inventory {
		record.Next = &layout.Pair{Label: "Next", Value: summary.next}
		record.Fields = []layout.Pair{{Label: "Observed", Value: m.deliveryObservedAt(summary.observedAt)}}
	}

	return record
}

func (m *Model) deliveryDetailContent(width int) string {
	return m.deliveryDocument(m.currentSubject()).View(width, m.theme)
}

func (m *Model) deliveryDocument(item subject) layout.DetailDocument {
	if item.url == "" {
		return layout.DetailDocument{Sections: []layout.DetailSection{{
			ID: "empty", Paragraphs: []string{"Select a GitHub delivery. Local worker runs are available in diagnostics."},
		}}}
	}

	summary := m.summarizeDelivery(item)

	record := layout.RecordSummary{
		Title:  m.link(item.url),
		Status: text.Pill(summary.condition, summary.tone, m.theme, text.Normal),
		Next:   &layout.Pair{Label: "Next action", Value: summary.next},
	}
	if summary.title != item.label {
		record.Title += " · " + summary.title
	}

	document := layout.DetailDocument{Summary: record, ActionDetail: summary.explanation}

	pr := item.tracked
	if pr == nil {
		document.Sections = []layout.DetailSection{{
			ID: "tracking", Title: "Tracking", FullWidth: true,
			Paragraphs: []string{"This PR is not enrolled for tracking; delivery gates and ownership are unavailable."},
		}}

		return document
	}

	document.Summary.Subtitle = "Observed " + m.deliveryObservedAt(summary.observedAt)
	feedback := m.deliveryFeedbackSections(pr)
	hasFeedback := len(feedback) > 0
	identity, verification := m.deliveryIdentitySection(pr), m.deliveryEvidenceSection(pr)

	document.Sections = []layout.DetailSection{identity, verification}
	if hasFeedback {
		// Lead with the active route so a delivery failure and its receipt can
		// be inspected together at narrow as well as wide terminal widths.
		document.Sections = append([]layout.DetailSection{feedback[0]}, document.Sections...)
		feedback = feedback[1:]
	}

	document.Sections = append(document.Sections, feedback...)

	document.Sections = append(document.Sections, m.deliveryMergeSection(pr))
	if !hasFeedback {
		document.Sections = append(document.Sections, layout.DetailSection{
			ID: "feedback", Title: "Feedback delivery", FullWidth: true,
			Paragraphs: []string{"No retained review actions for this PR."},
		})
	}

	if activity := m.deliveryActivitySection(item); len(activity.Timeline) != 0 {
		document.Sections = append(document.Sections, activity)
	}

	return document
}

func wrapDeliveryContent(content string, width int) string {
	return ansi.Hardwrap(ansi.Wrap(content, max(1, width), " "), max(1, width), true)
}

func (m *Model) deliveryIdentitySection(pr *v1.TrackedPullRequest) layout.DetailSection {
	o := pr.GetObservation()

	section := layout.DetailSection{
		ID: "identity", Title: "Identity",
		Fields: []layout.Pair{
			{Label: "Owner", Value: m.agentLabel(pr.GetOwnerAgentId())},
			{Label: "Tracked head", Value: deliveryRevision(o.GetHeadSha())},
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
		if details.GetHeadSha() != o.GetHeadSha() || o.GetHeadSha() == "" {
			section.Fields = append(section.Fields, layout.Pair{Label: "Review-cache head", Value: deliveryRevision(details.GetHeadSha())})
		}

		if details.GetHeadSha() != "" && o.GetHeadSha() != "" && details.GetHeadSha() != o.GetHeadSha() {
			section.Statuses = append(section.Statuses, layout.StatusItem{Label: "Review evidence", Value: text.Pill("Different revision", text.Warning, m.theme, text.Normal), Detail: "These sources cover different revisions; refresh before assessing readiness."})
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
	section := layout.DetailSection{ID: "readiness", Title: "Verification"}

	o := pr.GetObservation()
	if o == nil {
		section.Paragraphs = []string{"No stored GitHub observation. Readiness is unknown."}
		return section
	}

	checks, checkTone := deliveryCheckEvidence(o.GetChecks(), o.GetHeadSha())
	workflows, workflowTone := deliveryCheckEvidence(o.GetWorkflows(), o.GetHeadSha())
	review, reviewTone := deliveryReviewEvidence(o.GetReviews(), o.GetHeadSha())
	feedback := observationStatus(o.GetFeedback())
	section.Statuses = []layout.StatusItem{
		m.deliveryState("Checks", checks, checkTone),
		m.deliveryState("Workflows", workflows, workflowTone),
		m.deliveryState("Review coverage", review, reviewTone),
		m.deliveryState("Feedback coverage", feedback, coverageTone(feedback)),
	}
	open := m.openActions(pr.GetId())

	tone := text.Neutral
	if open > 0 {
		tone = text.Warning
	}

	section.Statuses = append(section.Statuses, m.deliveryState("Owner actions", counted(open, "outstanding action"), tone))
	if o.GetMergeability() != "" {
		section.Statuses = append(section.Statuses, m.deliveryState("Mergeability", o.GetMergeability(), text.Neutral))
	}

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

func deliveryCheckEvidence(evidence *v1.DomainCheckEvidence, head string) (string, text.Tone) {
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

	tone := coverageTone(parts[0])
	switch {
	case counts.failed > 0:
		tone = text.Danger
	case counts.unknown+counts.otherHead+counts.unpinned > 0 || parts[0] != "complete":
		tone = text.Warning
	case counts.pending > 0:
		tone = text.Info
	case counts.passed > 0:
		tone = text.Success
	}

	return strings.Join(parts, " · "), tone
}

func coverageTone(coverage string) text.Tone {
	if coverage == "complete" {
		return text.Neutral
	}

	return text.Warning
}

func (m *Model) deliveryState(label, value string, tone text.Tone) layout.StatusItem {
	return layout.StatusItem{Label: label, Value: text.ToneStyle(tone, text.Normal, m.theme).Render(safe(value))}
}

func deliveryReviewEvidence(evidence *v1.DomainReviewEvidence, head string) (string, text.Tone) {
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

	tone := coverageTone(parts[0])
	if different+unpinned > 0 {
		tone = text.Warning
	}

	return strings.Join(parts, " · "), tone
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
