package tui

import (
	"strings"

	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type activityPresentation struct{ title, detail, prURL string }

func (m *Model) eventPR(event *v1.JobEvent) string {
	if address, _ := parsePRURL(event.GetActionContext().GetPrUrl()); address != "" {
		return address
	}

	for _, pr := range m.snapshot.GetTracking().GetPrs() {
		if pr.GetId() == event.GetPrId() {
			return pr.GetUrl()
		}
	}

	for _, job := range m.snapshot.GetJobs() {
		if job.GetId() == event.GetJobId() {
			address, _ := pullRequest(job)
			return address
		}
	}

	return ""
}

func (m *Model) presentEvent(event *v1.JobEvent) activityPresentation {
	row := activityPresentation{title: "Update", detail: safe(event.GetDetail()), prURL: m.eventPR(event)}
	switch event.GetKind() {
	case "repair_progress":
		row.title = "Rebase repair"
	case "pr_observed":
		row.title = "PR checked"
		sha := strings.TrimPrefix(event.GetDetail(), "Observed head ")
		row.detail = "Head commit " + m.commitLink(row.prURL, sha)
	case "pr_tracked":
		row.title, row.detail = "PR tracking started", "Watching for conflicts, failed checks, and review requests."
	case "pr_retracked":
		row.title, row.detail = "PR tracking resumed", "Watching for blockers again."
	case "pr_untracked":
		row.title, row.detail = "PR tracking stopped", "History is retained."
	case "pr_assigned":
		row.title, row.detail = "PR owner changed", "Future notifications go to the assigned session."
	case "pr_refresh_failed":
		row.title = "PR check failed"
	case "action_opened":
		row.title = "Needs attention"
	case "action_progress":
		row.title = "Action update"
	case "action_resolved":
		row.title = "Blocker cleared"
	case "action_superseded":
		row.title = "Action superseded"
	case "action_reassigned":
		row.title = "Action reassigned"
	case "action_reprofiled":
		row.title = "Repair instructions changed"
	case "delivery_pending":
		row.title, row.detail = "Notification queued", "Waiting to notify the responsible session."
	case "delivery_sending":
		row.title, row.detail = "Notifying agent", "Sending the blocker to the responsible session."
	case "delivery_delivered", "delivery_reconciled":
		row.title, row.detail = "Notification accepted", "Codex accepted the notification for delivery; agent receipt and acknowledgment are unverified."
	case "delivery_uncertain":
		row.title, row.detail = "Notification unconfirmed", "The send may have reached the agent. Confirmation is unavailable."
	case "delivery_unavailable":
		row.title, row.detail = "Agent unavailable", "The notification could not be delivered."
	case "delivery_cancelled":
		row.title, row.detail = "Notification cancelled", "This notification is no longer applicable."
	case "delivery_retry_requested":
		row.title, row.detail = "Notification retry requested", "Another delivery attempt was requested."
	case "delivery_retry_wait", "delivery_waiting":
		row.title, row.detail = "Notification retry scheduled", "Waiting before another delivery attempt."
	default:
		if event.GetJobId() != "" {
			row.title = "Worker update"
		}
	}

	if strings.HasPrefix(event.GetKind(), "delivery_") {
		for _, action := range m.snapshot.GetTracking().GetActions() {
			if action.GetId() == event.GetActionId() {
				row.title += " · " + safe(action.GetSummary())
				break
			}
		}
	}

	return row
}

func repeatedObservation(previous, current activityItem) bool {
	a, b := previous.event, current.event
	return a != nil && b != nil && a.GetKind() == "pr_observed" && b.GetKind() == "pr_observed" && a.GetPrId() != "" && a.GetPrId() == b.GetPrId() && a.GetDetail() == b.GetDetail()
}
