package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func (m *Model) field(label, value string) string {
	return m.theme.Subtle().Render(label+": ") + text.Label(text.Inline(safe(value)), m.theme)
}
func (m *Model) muted(value string) string { return m.theme.Subtle().Render(safe(value)) }
func (m *Model) link(value string) string {
	return text.Label(text.FormatURL(safe(value), text.FullURL), m.theme)
}

func stateName(value, prefix string) string {
	return strings.ToLower(strings.TrimPrefix(value, prefix))
}

func actionTone(state v1.ActionState) text.Tone {
	switch state {
	case v1.ActionState_ACTION_STATE_OPEN:
		return text.Warning
	case v1.ActionState_ACTION_STATE_ACKNOWLEDGED, v1.ActionState_ACTION_STATE_WORKING:
		return text.Info
	case v1.ActionState_ACTION_STATE_RESOLVED:
		return text.Success
	case v1.ActionState_ACTION_STATE_UNSPECIFIED, v1.ActionState_ACTION_STATE_SUPERSEDED:
		return text.Neutral
	default:
		return text.Neutral
	}
}

func deliveryTone(state v1.DeliveryState) text.Tone {
	switch state {
	case v1.DeliveryState_DELIVERY_STATE_DELIVERED, v1.DeliveryState_DELIVERY_STATE_SENDING:
		return text.Info
	case v1.DeliveryState_DELIVERY_STATE_UNCERTAIN:
		return text.Warning
	case v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE:
		return text.Danger
	case v1.DeliveryState_DELIVERY_STATE_UNSPECIFIED, v1.DeliveryState_DELIVERY_STATE_PENDING, v1.DeliveryState_DELIVERY_STATE_CANCELLED:
		return text.Neutral
	default:
		return text.Neutral
	}
}

func outcomeTone(outcome v1.ActivityOutcome) text.Tone {
	switch outcome {
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_ATTEMPTED:
		return text.Info
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED:
		return text.Success
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_FAILED:
		return text.Danger
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_UNCERTAIN:
		return text.Warning
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_UNSPECIFIED:
		return text.Neutral
	default:
		return text.Neutral
	}
}

func sessionContext(label, cwd, id string) string {
	if value := strings.TrimSpace(safe(label)); value != "" {
		if strings.HasPrefix(value, "/") {
			return compactDirectory(value)
		}

		return ansi.Truncate(value, 48, "…")
	}

	if value := strings.TrimSpace(safe(cwd)); value != "" {
		return compactDirectory(value)
	}

	if value := safe(id); value != "" {
		return "session " + ansi.Truncate(value, 8, "")
	}

	return "Unknown session"
}

func compactDirectory(value string) string {
	parts := strings.Split(strings.TrimRight(value, "/"), "/")
	if len(parts) > 2 {
		value = "…/" + strings.Join(parts[len(parts)-2:], "/")
	}

	if value == "" {
		value = "/"
	}

	return ansi.Truncate(value, 48, "…")
}
