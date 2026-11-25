package presentation

import (
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func ActionTone(state v1.ActionState) text.Tone {
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

func DeliveryTone(state v1.DeliveryState) text.Tone {
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

func OutcomeTone(outcome v1.ActivityOutcome) text.Tone {
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
