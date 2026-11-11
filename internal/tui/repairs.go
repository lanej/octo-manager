package tui

import (
	"strings"
	"time"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func repairTone(state v1.RepairState) text.Tone {
	switch state {
	case v1.RepairState_REPAIR_STATE_SUCCEEDED:
		return text.Success
	case v1.RepairState_REPAIR_STATE_FAILED:
		return text.Danger
	case v1.RepairState_REPAIR_STATE_BLOCKED, v1.RepairState_REPAIR_STATE_UNCERTAIN:
		return text.Warning
	case v1.RepairState_REPAIR_STATE_RUNNING, v1.RepairState_REPAIR_STATE_AWAITING_CHECKS:
		return text.Info
	case v1.RepairState_REPAIR_STATE_UNSPECIFIED, v1.RepairState_REPAIR_STATE_QUEUED:
		return text.Neutral
	default:
		return text.Neutral
	}
}

func (m *Model) repairContent(prID string) string {
	var parts []string

	for _, repair := range m.snapshot.GetRepairs() {
		if repair.GetPrId() != prID {
			continue
		}

		parts = append(parts, "", text.Log("Rebase", m.theme)+" "+text.Pill(strings.ReplaceAll(stateName(repair.GetState().String(), "REPAIR_STATE_"), "_", " "), repairTone(repair.GetState()), m.theme, text.Normal), text.Label(safe(repair.GetDetail()), m.theme), m.muted(time.UnixMilli(repair.GetUpdatedAtMs()).UTC().Format("Jan 2, 2006 · 15:04 UTC")), m.field("Repair method", repairMethod(repair)))
		if repair.GetResultHead() != "" {
			parts = append(parts, m.commitField("Rebased commit", repair.GetPrUrl(), repair.GetResultHead()))
		}

		if len(repair.GetConflictedPaths()) > 0 {
			parts = append(parts, m.field("Conflicts", strings.Join(repair.GetConflictedPaths(), ", ")))
		}
	}

	return strings.Join(parts, "\n")
}

func repairMethod(repair *v1.RepairAttempt) string {
	if repair.GetUsedAgent() {
		return repair.GetHarness() + " · " + repair.GetModel()
	}

	return "Git tools"
}
