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
	case "pr_draining":
		row.title = "Finishing PR checks"
	case "pr_archived":
		row.title = "PR monitoring archived"
	case "pr_reactivated":
		row.title = "Reopened PR monitoring"
	case "notification_monitor_unavailable":
		row.title = "GitHub notifications unavailable"
	case "notification_monitor_recovered":
		row.title = "GitHub notifications restored"
	case "pr_observed":
		row.title = "PR checked"
		sha := strings.TrimPrefix(event.GetDetail(), "Observed head ")
		row.detail = m.commitLink(row.prURL, sha)
	case "pr_tracked":
		row.title, row.detail = "PR tracking started", ""
	case "pr_retracked":
		row.title, row.detail = "PR tracking resumed", ""
	case "pr_untracked":
		row.title, row.detail = "PR tracking stopped", ""
	case "pr_assigned":
		row.title, row.detail = "PR owner changed", "The assigned session owns actions; observers keep listening."
	case "pr_subscribed":
		row.title = "PR listener added"
	case "pr_unsubscribed":
		row.title = "PR listener removed"
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
		row.title, row.detail = "Notification queued", ""
	case "delivery_sending":
		row.title, row.detail = "Notifying agent", ""
	case "delivery_delivered", "delivery_reconciled":
		row.title, row.detail = "Notification accepted", "Agent receipt and acknowledgment unverified."
	case "message_acknowledged":
		row.title, row.detail = "Agent received notification", "Receipt recorded."
	case "delivery_receipt_unavailable":
		row.title, row.detail = "Receipt check unavailable", "Receipt unverified."
	case "delivery_uncertain":
		row.title, row.detail = "Notification unconfirmed", "Delivery unconfirmed."
	case "delivery_unavailable":
		row.title, row.detail = "Agent unavailable", ""
	case "delivery_cancelled":
		row.title, row.detail = "Notification cancelled", ""
	case "delivery_retry_requested":
		row.title, row.detail = "Notification retry requested", ""
	case "delivery_retry_wait", "delivery_waiting":
		row.title, row.detail = "Notification retry scheduled", ""
	default:
		if event.GetJobId() != "" {
			row.title = "Worker update"
		}
	}

	if strings.HasPrefix(event.GetKind(), "delivery_") {
		for _, action := range m.snapshot.GetTracking().GetActions() {
			if action.GetId() == event.GetActionId() {
				parts := []string{safe(action.GetSummary())}
				if row.detail != "" {
					parts = append(parts, row.detail)
				}

				row.detail = strings.Join(parts, " · ")

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
