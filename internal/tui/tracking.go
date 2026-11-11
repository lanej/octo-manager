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

	for _, action := range m.snapshot.GetTracking().GetActions() {
		if action.GetPrId() == prID && !actionClosed(action.GetState()) {
			count++
		}
	}

	return count
}

func (m *Model) trackingContent() string {
	pr := m.currentSubject().tracked
	if pr == nil {
		return "This PR is not enrolled. Use octo-manager track --url URL --thread-id ID from its owning agent session."
	}

	parts := []string{text.Badge("PR tracking", m.theme), m.trackingLinks(pr), m.field("Owner", m.agentLabel(pr.GetOwnerAgentId()))}
	if pr.GetOriginAgentId() != pr.GetOwnerAgentId() {
		parts = append(parts, m.field("Origin", m.agentLabel(pr.GetOriginAgentId())))
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

		parts = append(parts, m.field("Checks", observationStatus(o.GetChecksJson()))+" · "+m.field("Reviews", observationStatus(o.GetReviewsJson())))
	} else {
		parts = append(parts, text.PendingWithPresentation(text.GlyphAndLabel, m.theme)+" Waiting for the first GitHub observation.")
	}

	parts = append(parts, m.repairContent(pr.GetId()))

	count := m.openActions(pr.GetId())

	tone := text.Success
	if count > 0 {
		tone = text.Warning
	}

	parts = append(parts, "", text.Pill(fmt.Sprintf("%d outstanding actions", count), tone, m.theme, text.Normal))

	actions := m.snapshot.GetTracking().GetActions()
	for _, closed := range []bool{false, true} {
		for _, action := range actions {
			if action.GetPrId() != pr.GetId() || actionClosed(action.GetState()) != closed {
				continue
			}

			parts = append(parts, "", text.Pill(stateName(action.GetState().String(), "ACTION_STATE_"), actionTone(action.GetState()), m.theme, text.Normal)+" "+text.Label(safe(action.GetSummary()), m.theme))
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

				parts = append(parts, "Delivery "+text.Pill(stateName(delivery.GetState().String(), "DELIVERY_STATE_"), deliveryTone(delivery.GetState()), m.theme, text.Normal)+" · "+text.Label(m.agentLabel(delivery.GetRecipientAgentId()), m.theme), strings.TrimSpace(m.deliveryDetails(delivery.GetProgressJson())))
			}

			if action.GetCloseReason() != "" {
				parts = append(parts, m.muted(action.GetCloseReason()))
			}

			parts = append(parts, m.link(action.GetEvidenceUrl()))
		}
	}

	parts = append(parts, "", text.KeyHint("u", "refresh", m.theme), m.muted("Delivery, acknowledgment, and verified resolution are separate."))

	return strings.Join(parts, "\n")
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
		NextAttemptAt int64
	}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "Delivery details unavailable.\n\n"
	}

	if value.Reason != "" {
		return safe(value.Reason) + "\n\n"
	}

	if value.NextAttemptAt != 0 {
		return "Next attempt " + m.timestamp(value.NextAttemptAt, fullTimestamp) + "\n\n"
	}

	return ""
}
