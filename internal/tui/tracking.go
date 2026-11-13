package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/lanej/charmed/feedback"
	"github.com/lanej/charmed/input"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func (m *Model) agentLabel(id string) string {
	for _, agent := range m.snapshot.GetTracking().GetAgents() {
		if agent.GetId() != id {
			continue
		}

		target := agent.GetTarget()

		result := safe(target.GetHarness()) + " · " + sessionContext(target.GetLabel(), "", target.GetSessionId())

		return result
	}

	return sessionContext("", "", id)
}

func actionClosed(state v1.ActionState) bool {
	switch state {
	case v1.ActionState_ACTION_STATE_RESOLVED, v1.ActionState_ACTION_STATE_SUPERSEDED:
		return true
	case v1.ActionState_ACTION_STATE_UNSPECIFIED, v1.ActionState_ACTION_STATE_OPEN, v1.ActionState_ACTION_STATE_ACKNOWLEDGED, v1.ActionState_ACTION_STATE_WORKING:
		return false
	default:
		return false
	}
}

func (m *Model) openActions(prID string) int {
	count := 0

	var pr *v1.TrackedPullRequest

	for _, tracked := range m.snapshot.GetTracking().GetPrs() {
		if tracked.GetId() == prID {
			pr = tracked

			break
		}
	}

	for _, action := range m.snapshot.GetTracking().GetActions() {
		if action.GetPrId() == prID && !actionHistorical(action, pr) {
			count++
		}
	}

	return count
}

func actionHistorical(action *v1.PendingAction, pr *v1.TrackedPullRequest) bool {
	lifecycle := pr.GetObservation().GetLifecycle()

	return actionClosed(action.GetState()) || lifecycle == "closed" || lifecycle == "merged"
}

func (m *Model) trackingContent() string {
	pr := m.currentSubject().tracked
	if pr == nil {
		return "This PR is not enrolled. Use octo-manager track --url URL --thread-id ID from its owning agent session."
	}

	parts := []string{text.Badge("PR tracking", m.theme), m.trackingLinks(pr), m.field("Owner", m.agentLabel(pr.GetOwnerAgentId())), m.trackingAutomation(pr)}
	if status := m.selectedRefresh; status != nil {
		parts = append(parts, m.field("Refresh", stateName(status.GetState().String(), "REFRESH_STATE_")), m.field("Next eligible", m.timestamp(status.GetDueAtMs(), fullTimestamp)))
		if status.GetLastError() != "" {
			parts = append(parts, m.field("Refresh error", safe(status.GetLastError())))
		}
	}

	if pr.GetOriginAgentId() != pr.GetOwnerAgentId() {
		parts = append(parts, m.field("Origin", m.agentLabel(pr.GetOriginAgentId())))
	}

	if pr.GetTrackingState() != v1.TrackingState_TRACKING_STATE_UNSPECIFIED {
		parts = append(parts, m.field("Monitoring", stateName(pr.GetTrackingState().String(), "TRACKING_STATE_")))
	}

	if pr.GetArchiveReason() == "deadline" {
		parts = append(parts, feedback.Warn.View(text.Normal, m.theme)+" Drain deadline reached; check results remain incomplete.")
	}

	if !pr.GetEnabled() {
		parts = append(parts, feedback.Disabled.View(text.Dim, m.theme)+" History is retained.")
	}

	if pr.GetRefreshError() != "" {
		parts = append(parts, feedback.Warn.View(text.Normal, m.theme)+" Refresh failed: "+text.Label(safe(pr.GetRefreshError()), m.theme), m.muted("Previous observation retained."))
	}

	if o := pr.GetObservation(); o != nil {
		tone := text.Neutral
		if o.GetMergeability() == "conflicting" {
			tone = text.Warning
		} else if o.GetMergeability() == "mergeable" {
			tone = text.Success
		}

		parts = append(parts, text.Pill(safe(o.GetLifecycle()), text.Neutral, m.theme, text.Dim)+" "+text.Pill(safe(o.GetMergeability()), tone, m.theme, text.Normal), m.field("Observed", m.timestamp(o.GetObservedAtMs(), fullTimestamp)))
		if o.GetTargetBase() == nil {
			parts = append(parts, m.muted("Current target revision unavailable (legacy or closed observation)."))
		}

		parts = append(parts, m.field("Checks", observationStatus(o.GetChecksJson()))+" · "+m.field("Reviews", observationStatus(o.GetReviewsJson()))+" · "+m.field("Feedback", observationStatus(o.GetFeedbackJson())))
	} else {
		parts = append(parts, text.PendingWithPresentation(text.GlyphAndLabel, m.theme)+" Waiting for the first GitHub observation.")
	}

	parts = append(parts, m.checkWatchContent(pr), m.repairContent(pr.GetId()))
	for _, merge := range m.snapshot.GetMergeStatuses() {
		if merge.GetPrId() != pr.GetId() {
			continue
		}

		parts = append(parts, m.field("Merge chain", strings.ReplaceAll(merge.GetState(), "_", " ")), m.field("Next step", merge.GetDetail()))
		for _, prerequisite := range merge.GetPrerequisiteUrls() {
			parts = append(parts, m.field("Requires merge", m.trackingLinks(&v1.TrackedPullRequest{Url: prerequisite})))
		}
	}

	overview := strings.Join(parts, "\n")
	parts = nil
	count := m.openActions(pr.GetId())

	tone := text.Success
	if count > 0 {
		tone = text.Warning
	}

	parts = append(parts, "", text.Pill(counted(count, "outstanding action"), tone, m.theme, text.Normal))
	if lifecycle := pr.GetObservation().GetLifecycle(); lifecycle == "closed" || lifecycle == "merged" {
		parts = append(parts, m.muted("Pull request is "+lifecycle+"; action records are retained as history."))
	}

	actions := m.snapshot.GetTracking().GetActions()

	for _, closed := range []bool{false, true} {
		heading := false

		for _, action := range actions {
			if action.GetPrId() != pr.GetId() || actionHistorical(action, pr) != closed {
				continue
			}

			if closed && !heading {
				parts = append(parts, "", text.Badge("Action history", m.theme))
				heading = true
			}

			parts = append(parts, "", text.Pill(stateName(action.GetState().String(), "ACTION_STATE_"), actionTone(action.GetState()), m.theme, text.Normal)+" "+text.Label(safe(action.GetSummary()), m.theme))
			if result := action.GetCheckResults(); result != nil {
				parts = append(parts, m.checkResultsContent(result, pr))
			}

			if comment := action.GetReviewFeedback(); comment != nil {
				location := comment.GetPath()

				if comment.GetLine() > 0 {
					location += fmt.Sprintf(":%d", comment.GetLine())
				}

				if location != "" {
					parts = append(parts, m.field("Location", location))
				}

				parts = append(parts, text.Label(safe(comment.GetBody()), m.theme))
			}

			if profile := action.GetProfile(); profile != nil {
				parts = append(parts, m.field("Profile", profile.GetName()))
				if profile.GetHarness() != "" {
					parts = append(parts, m.field("Harness", profile.GetHarness()))
				}

				if profile.GetModel() != "" {
					parts = append(parts, m.field("Model", profile.GetModel()))
				}

				parts = append(parts, text.Label(safe(profile.GetInstructions()), m.theme))
			}

			for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
				if delivery.GetActionId() != action.GetId() {
					continue
				}

				details := strings.TrimSpace(m.deliveryDetails(delivery.GetProgressJson()))
				if delivery.AcknowledgedAtMs != nil && strings.HasSuffix(details, "; receipt pending.") {
					details = strings.TrimSuffix(details, "; receipt pending.") + "."
				}

				parts = append(parts, "Delivery "+text.Pill(stateName(delivery.GetState().String(), "DELIVERY_STATE_"), deliveryTone(delivery.GetState()), m.theme, text.Normal)+" · "+text.Label(m.agentLabel(delivery.GetRecipientAgentId()), m.theme), details)
				if delivery.MessageSequence != nil {
					receipt := "Awaiting agent receipt"
					if delivery.AcknowledgedAtMs != nil {
						receipt = "Agent received " + m.timestamp(delivery.GetAcknowledgedAtMs(), fullTimestamp)
					}

					parts = append(parts, m.field("Receipt", receipt))
				} else {
					parts = append(parts, m.muted("Receipt unavailable for this legacy delivery."))
				}
			}

			if action.GetCloseReason() != "" {
				parts = append(parts, m.muted(action.GetCloseReason()))
			}

			parts = append(parts, m.link(action.GetEvidenceUrl()))
		}
	}

	parts = append(parts, "", text.KeyHint("u", "refresh", m.theme), m.muted("Delivery, acknowledgment, and verified resolution are separate."))

	width := max(1, layout.PanelContentSize(layout.Size{Width: m.geometry().right}).Width-1)
	if width < 32 {
		return overview + "\n" + strings.Join(parts, "\n")
	}

	return m.sections("tracking-sections", width, dashboardSection{id: "ownership", title: "AUTOMATION & OWNERSHIP", content: func(int) string { return overview }}, dashboardSection{id: "blockers", title: "ACTIONS & DELIVERY", content: func(int) string { return strings.Join(parts, "\n") }})
}

func (m *Model) trackingLinks(pr *v1.TrackedPullRequest) string {
	var (
		links       []text.Link
		unavailable []string
	)

	add := func(address, label string) {
		link, err := webLink(address)
		if err != nil {
			unavailable = append(unavailable, m.muted("Link unavailable"))
			return
		}

		if label != "" {
			link.Label = text.Inline(safe(label))
		}

		links = append(links, link)
	}
	add(pr.GetUrl(), "")

	if o := pr.GetObservation(); o != nil {
		repository, _ := parsePRURL(pr.GetUrl())
		revision := func(label, sha string) {
			if !validCommit(sha) || repository == "" {
				unavailable = append(unavailable, m.muted(label+": unavailable"))
				return
			}

			add(strings.Split(repository, "/pull/")[0]+"/commit/"+sha, label+": "+sha[:8])
		}
		revision("Head", o.GetHeadSha())
		revision("PR-reported base", o.GetBaseSha())

		if target := o.GetTargetBase(); target != nil {
			revision("Target "+target.GetRef(), target.GetSha())
		}
	}

	g := m.geometry()
	inner := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.result})

	view, err := (layout.LinkGroup{Links: links}).View(max(1, inner.Width-1), m.theme)
	if err != nil {
		return m.muted("Links unavailable")
	}

	return strings.Join(append([]string{view}, unavailable...), "\n")
}

func (m *Model) autoMergeEnabled(prID string) bool {
	enabled := false

	for _, status := range m.snapshot.GetMergeStatuses() {
		if status.GetPrId() == prID {
			enabled = status.GetAutoMerge() && status.GetState() != "merged" && status.GetState() != "cancelled"
		}
	}

	return enabled
}

func (m *Model) toggleAutoMerge() tea.Cmd {
	pr := m.currentSubject().tracked
	if pr == nil || m.commandPending {
		return nil
	}

	enabled := !m.autoMergeEnabled(pr.GetId())

	body, err := json.Marshal(struct {
		Op      string `json:"op"`
		PR      string `json:"pr"`
		Enabled bool   `json:"enabled"`
		Actor   string `json:"actorId"`
		Request string `json:"requestId"`
	}{Op: "auto_merge", PR: pr.GetId(), Enabled: enabled, Actor: pr.GetOwnerAgentId(), Request: fmt.Sprintf("dashboard-auto-%s-%d", pr.GetId(), time.Now().UnixNano())})
	if err != nil {
		return func() tea.Msg { return commandMsg{err: err} }
	}

	m.commandPending = true

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 15*time.Second)
		defer cancel()

		_, err := m.api.RPC.MergeCommand(ctx, connect.NewRequest(&v1.MergeCommandRequest{InputJson: string(body)}))

		return commandMsg{err: err}
	}
}

func (m *Model) refreshTracked() tea.Cmd {
	pr := m.currentSubject().tracked
	if pr == nil || m.commandPending {
		return nil
	}

	m.commandPending = true
	id := pr.GetId()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 2*time.Minute)
		defer cancel()

		_, err := m.api.RPC.RefreshTrackedPullRequest(ctx, connect.NewRequest(&v1.RefreshTrackedPullRequestRequest{Id: id}))

		return commandMsg{err: err}
	}
}

func observationStatus(raw string) string {
	var value struct {
		State  string
		Reason string
	}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "unavailable"
	}

	result := safe(value.State)
	if value.Reason != "" {
		result += " (" + safe(value.Reason) + ")"
	}

	return result
}

func (m *Model) deliveryDetails(raw string) string {
	var value struct {
		Reason        string
		Note          string
		NextAttemptAt int64
	}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "Delivery details unavailable.\n\n"
	}

	if value.Reason != "" {
		return safe(value.Reason) + "\n\n"
	}

	if value.Note != "" {
		return safe(value.Note) + "\n\n"
	}

	if value.NextAttemptAt != 0 {
		return "Next attempt " + m.timestamp(value.NextAttemptAt, fullTimestamp) + "\n\n"
	}

	return ""
}

func (m *Model) trackingAutomation(pr *v1.TrackedPullRequest) string {
	label := m.automationLabel(pr.GetId())

	lifecycle := pr.GetObservation().GetLifecycle()
	if lifecycle == "merged" || lifecycle == "closed" {
		return text.Pill(label, text.Neutral, m.theme, text.Normal)
	}

	toggle := input.NewToggle("auto-merge", "Auto-merge (a)", m.autoMergeEnabled(pr.GetId()), m.theme).View()
	if label == "Auto-merge ON" || label == "Manual merge" {
		return toggle
	}

	return toggle + "\n" + label
}
