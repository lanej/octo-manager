package tui

import (
	"fmt"
	"sort"
	"strings"

	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func (m *Model) deliveryFeedbackSections(pr *v1.TrackedPullRequest) []layout.DetailSection {
	type reviewAction struct {
		action     *v1.PendingAction
		condition  deliveryCondition
		historical bool
	}

	var actions []reviewAction

	for _, action := range m.snapshot.GetTracking().GetActions() {
		if action.GetPrId() != pr.GetId() || (action.GetReviewFeedback() == nil && action.GetChangesRequested() == nil) {
			continue
		}

		actions = append(actions, reviewAction{
			action: action, condition: m.ownerActionCondition(action, pr.GetOwnerAgentId()), historical: actionHistorical(action, pr),
		})
	}

	sort.SliceStable(actions, func(i, j int) bool {
		left, right := actions[i], actions[j]
		switch {
		case left.historical != right.historical:
			return !left.historical
		case !left.historical && left.condition.group != right.condition.group:
			return left.condition.group < right.condition.group
		case !left.historical && left.condition.priority != right.condition.priority:
			return left.condition.priority < right.condition.priority
		default:
			return left.action.GetUpdatedAtMs() > right.action.GetUpdatedAtMs()
		}
	})

	sections := []layout.DetailSection{}
	for _, action := range actions[:min(4, len(actions))] {
		sections = append(sections, m.feedbackRoutes(pr, action.action)...)
	}

	if len(actions) > 4 {
		sections = append(sections, layout.DetailSection{ID: "feedback-limits", FullWidth: true, Paragraphs: []string{
			fmt.Sprintf("%d additional review actions are available in Tracking diagnostics.", len(actions)-4),
		}})
	}

	return sections
}

func (m *Model) feedbackRoutes(pr *v1.TrackedPullRequest, action *v1.PendingAction) []layout.DetailSection {
	// The owner and each observer have independent transport and receipt records.
	// Keep the owner's most recent attempt first without discarding older attempts.
	owner := action.GetOwnerAgentId()
	if owner == "" && !actionHistorical(action, pr) {
		owner = pr.GetOwnerAgentId()
	}

	ownerDelivery := m.latestOwnerDelivery(action.GetId(), owner)

	deliveries := []*v1.ActionDelivery{}
	if owner != "" || ownerDelivery != nil {
		deliveries = append(deliveries, ownerDelivery)
	}

	for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
		if delivery != ownerDelivery && delivery.GetActionId() == action.GetId() {
			deliveries = append(deliveries, delivery)
		}
	}

	if len(deliveries) == 0 {
		deliveries = append(deliveries, nil)
	}

	source, head := feedbackSource(action)
	sourceStage := m.deliveryState("Review source", source, text.Info)
	sourceStage.Detail = "Reviewed head " + deliveryRevision(head)
	disposition := m.deliveryState("Disposition", stateName(action.GetState().String(), "ACTION_STATE_"), actionTone(action.GetState()))
	disposition.Detail = m.agentLabel(owner)

	sections := make([]layout.DetailSection, 0, len(deliveries))
	for index, delivery := range deliveries {
		transport, receipt := m.feedbackReceipt(delivery)

		id := delivery.GetId()
		if delivery == nil {
			transport.Detail = m.agentLabel(owner)
			id = "unrecorded"
		} else if id == "" {
			id = delivery.GetRecipientAgentId()
		}

		section := layout.DetailSection{
			ID:    "feedback:" + action.GetId() + ":recipient:" + id,
			Title: "Feedback delivery · " + action.GetSummary(), FullWidth: true,
			Stages: []layout.StatusItem{sourceStage, transport, receipt, disposition},
		}
		if index == 0 {
			m.addFeedbackProvenance(&section, pr, action, head)
		}

		if delivery.GetProgress() != nil && (delivery.GetState() == v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE || delivery.GetState() == v1.DeliveryState_DELIVERY_STATE_UNCERTAIN) {
			if reason := strings.TrimSpace(m.deliveryDetails(delivery.GetProgress())); reason != "" {
				section.Paragraphs = append(section.Paragraphs, reason)
			}
		}

		sections = append(sections, section)
	}

	return sections
}

func feedbackSource(action *v1.PendingAction) (string, string) {
	if feedback := action.GetReviewFeedback(); feedback != nil {
		return feedback.GetAuthor() + " · " + feedback.GetSource(), feedback.GetHeadSha()
	}

	review := action.GetChangesRequested()

	return review.GetReviewer() + " · changes requested", review.GetReviewedHeadSha()
}

func (m *Model) addFeedbackProvenance(section *layout.DetailSection, pr *v1.TrackedPullRequest, action *v1.PendingAction, head string) {
	if head != "" && pr.GetObservation().GetHeadSha() != "" && head != pr.GetObservation().GetHeadSha() {
		section.Paragraphs = append(section.Paragraphs, "Feedback references a different revision.")
	}

	if actionHistorical(action, pr) {
		section.Paragraphs = append(section.Paragraphs, "Retained as history; the recorded disposition is unchanged.")
	}

	if action.GetCloseReason() != "" {
		section.Paragraphs = append(section.Paragraphs, "Disposition reason: "+action.GetCloseReason())
	}

	observed := "Review observed " + m.deliveryObservedAt(action.GetCreatedAtMs())
	if action.GetEvidenceUrl() != "" {
		section.Body = m.detailLinks(observed, action.GetEvidenceUrl())
	} else {
		section.Paragraphs = append(section.Paragraphs, observed)
	}
}

func (m *Model) feedbackReceipt(delivery *v1.ActionDelivery) (layout.StatusItem, layout.StatusItem) {
	if delivery == nil {
		return m.deliveryState("Transport", "No delivery recorded", text.Neutral), m.deliveryState("Receipt", "Not recorded", text.Neutral)
	}

	transport := m.deliveryState("Transport", stateName(delivery.GetState().String(), "DELIVERY_STATE_"), deliveryTone(delivery.GetState()))
	transport.Detail = m.agentLabel(delivery.GetRecipientAgentId())

	receipt := m.deliveryState("Receipt", "Not confirmed", text.Neutral)
	if delivery.AcknowledgedAtMs != nil {
		receipt = m.deliveryState("Receipt", "Received", text.Success)
		receipt.Detail = m.deliveryObservedAt(delivery.GetAcknowledgedAtMs())
	} else if delivery.MessageSequence == nil {
		receipt = m.deliveryState("Receipt", "Unavailable", text.Warning)
		receipt.Detail = "No receipt identifier recorded"
	}

	return transport, receipt
}

func (m *Model) deliveryActivitySection(item subject) layout.DetailSection {
	section := layout.DetailSection{ID: "activity", Title: "Recent activity", FullWidth: true}

	for _, event := range m.snapshot.GetRecentEvents() {
		if m.eventPR(event) != item.url {
			continue
		}

		section.Timeline = append(section.Timeline, layout.TimelineEvent{
			When: m.deliveryObservedAt(event.GetAtMs()), Title: m.presentEvent(event).title, Detail: event.GetDetail(),
		})
	}

	return section
}
