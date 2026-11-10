package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func (m *Model) agentLabel(id string) string {
	for _, agent := range m.snapshot.GetTracking().GetAgents() {
		if agent.GetId() != id {
			continue
		}

		target := agent.GetTarget()

		label := target.GetLabel()
		if label == "" {
			label = target.GetSessionId()
		}

		result := safe(target.GetHarness()) + "/" + safe(target.GetEndpoint()) + " · " + safe(label)
		if agent.GetHarnessVersion() != "" {
			result += " · " + safe(agent.GetHarnessVersion())
		}

		return result
	}

	return safe(id)
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

func (m *Model) trackingMarkdown() string {
	pr := m.currentSubject().tracked
	if pr == nil {
		return "This PR is not enrolled. Use `octo-manager track --url URL --thread-id ID` from its owning agent session."
	}

	result := "# PR tracking\n\n**Owner:** " + m.agentLabel(pr.GetOwnerAgentId()) + "\n\n"
	if pr.GetOriginAgentId() != pr.GetOwnerAgentId() {
		result += "**Origin:** " + m.agentLabel(pr.GetOriginAgentId()) + "\n\n"
	}

	if !pr.GetEnabled() {
		result += "**Tracking disabled.** History is retained.\n\n"
	}

	if pr.GetRefreshError() != "" {
		result += "**Refresh failed:** " + safe(pr.GetRefreshError()) + "\n\nPrevious observation retained.\n\n"
	}

	if o := pr.GetObservation(); o != nil {
		result += safe(o.GetLifecycle()) + " · mergeability " + safe(o.GetMergeability()) + " · observed " + time.UnixMilli(o.GetObservedAtMs()).UTC().Format("2006-01-02 15:04:05 UTC") + "\n\nHead `" + shortSHA(o.GetHeadSha()) + "` · base `" + shortSHA(o.GetBaseSha()) + "`\n\n"
		result += "Checks " + observationStatus(o.GetChecksJson()) + " · reviews " + observationStatus(o.GetReviewsJson()) + "\n\n"
	} else {
		result += "Waiting for the first GitHub observation.\n\n"
	}

	result += fmt.Sprintf("**%d outstanding actions**\n\n", m.openActions(pr.GetId()))
	for _, action := range m.snapshot.GetTracking().GetActions() {
		if action.GetPrId() != pr.GetId() {
			continue
		}

		state := strings.ToLower(strings.TrimPrefix(action.GetState().String(), "ACTION_STATE_"))

		result += "## " + safe(action.GetSummary()) + "\n\n**" + state + "** · `" + safe(action.GetId()) + "`\n\n"
		if profile := action.GetProfile(); profile != nil {
			result += "Profile **" + safe(profile.GetName()) + "**"
			if profile.GetHarness() != "" {
				result += " · harness " + safe(profile.GetHarness())
			}

			if profile.GetModel() != "" {
				result += " · model " + safe(profile.GetModel())
			}

			result += "\n\n" + safe(profile.GetInstructions()) + "\n\n"
		}

		for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
			if delivery.GetActionId() != action.GetId() {
				continue
			}

			result += "Delivery **" + strings.ToLower(strings.TrimPrefix(delivery.GetState().String(), "DELIVERY_STATE_")) + "** to " + m.agentLabel(delivery.GetRecipientAgentId()) + "\n\n"
			result += deliveryDetails(delivery.GetProgressJson())
		}

		if action.GetCloseReason() != "" {
			result += safe(action.GetCloseReason()) + "\n\n"
		}

		result += safe(action.GetEvidenceUrl()) + "\n\n"
	}

	return result + "Press **u** to refresh. A delivered notification is not an acknowledgment or a verified resolution."
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

func deliveryDetails(raw string) string {
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
		return "Next attempt " + time.UnixMilli(value.NextAttemptAt).UTC().Format("2006-01-02 15:04:05 UTC") + "\n\n"
	}

	return ""
}
