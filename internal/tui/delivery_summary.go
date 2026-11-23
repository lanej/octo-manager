package tui

import (
	"cmp"
	"slices"
	"strings"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

type deliveryGroup uint8

const (
	attentionDeliveries deliveryGroup = iota
	movingDeliveries
	settledDeliveries
)

type deliverySummary struct {
	item                   subject
	title, condition, next string
	group                  deliveryGroup
	tone                   text.Tone
	observedAt             int64
	priority               int
}

type deliveryCondition struct {
	condition, next string
	group           deliveryGroup
	tone            text.Tone
	priority        int
}

func (m *Model) deliverySummaries() []deliverySummary {
	subjects := m.subjects()
	items := make([]deliverySummary, 0, len(subjects))

	for _, item := range subjects {
		if item.url != "" {
			items = append(items, m.summarizeDelivery(item))
		}
	}

	slices.SortFunc(items, func(a, b deliverySummary) int {
		if order := cmp.Compare(a.group, b.group); order != 0 {
			return order
		}

		if order := cmp.Compare(a.priority, b.priority); order != 0 {
			return order
		}

		return strings.Compare(a.item.key, b.item.key)
	})

	return items
}

func (m *Model) summarizeDelivery(item subject) deliverySummary {
	title := item.label
	if cached := m.reviews[item.url]; cached.GetTitle() != "" {
		title = safe(cached.GetTitle())
	}

	condition := m.deliveryCondition(item.tracked)

	return deliverySummary{
		item: item, title: title,
		condition: condition.condition, next: condition.next,
		group: condition.group, tone: condition.tone, priority: condition.priority,
		observedAt: item.tracked.GetObservation().GetObservedAtMs(),
	}
}

func intervention(condition, next string, priority int) deliveryCondition {
	return deliveryCondition{condition: condition, next: next, group: attentionDeliveries, tone: text.Warning, priority: priority}
}

func progressing(condition, next string) deliveryCondition {
	return deliveryCondition{condition: condition, next: next, group: movingDeliveries, tone: text.Info}
}

func settled(condition, next string) deliveryCondition {
	return deliveryCondition{condition: condition, next: next, group: settledDeliveries, tone: text.Neutral}
}

func (m *Model) deliveryCondition(pr *v1.TrackedPullRequest) deliveryCondition {
	if pr == nil {
		return intervention("Not enrolled for tracking", "Enroll from the owning session to receive delivery updates", 60)
	}

	merge := m.mergeStatus(pr.GetId())
	if merge.GetState() == "merged" || pr.GetObservation().GetLifecycle() == "merged" {
		result := settled("Merge confirmed", "Inspect the delivery receipt; task acceptance is separate")
		result.tone = text.Success

		return result
	}

	if pr.GetObservation().GetLifecycle() == "closed" {
		return settled("PR closed", "Inspect retained delivery history")
	}

	if merge.GetState() == "uncertain" {
		return intervention("Merge outcome unknown", "Inspect and reconcile the saved operation before another attempt", 0)
	}

	if merge.GetChainState() == "cancelled" && merge.GetState() != "cancelled" {
		return intervention("Stopped; reconciliation pending", "Confirm the in-flight operation's outcome", 1)
	}

	repairCondition, repairApplies := deliveryCondition{}, false
	if repair := m.deliveryRepair(pr); repair != nil {
		repairCondition, repairApplies = repairDeliveryCondition(repair)
		if repairApplies && repairCondition.group == attentionDeliveries {
			return repairCondition
		}
	}

	if !pr.GetEnabled() {
		return intervention("Monitoring stopped", "Inspect enrollment and retained evidence", 50)
	}

	switch pr.GetTrackingState() {
	case v1.TrackingState_TRACKING_STATE_DISABLED, v1.TrackingState_TRACKING_STATE_ARCHIVED:
		return intervention("Monitoring stopped", "Inspect enrollment and retained evidence", 50)
	case v1.TrackingState_TRACKING_STATE_UNSPECIFIED, v1.TrackingState_TRACKING_STATE_WATCHING, v1.TrackingState_TRACKING_STATE_DRAINING:
		// An unspecified state retains the enabled legacy enrollment.
	default:
		return intervention("Monitoring state unavailable", "Inspect enrollment and retained evidence", 50)
	}

	if merge.GetChainState() == "paused" {
		return intervention("Merge chain paused", "Inspect the chain before resuming automatic work", 40)
	}

	if merge.GetState() == "cancelled" {
		return intervention("Automatic merge stopped", "Inspect the open PR before authorizing further merge work", 45)
	}

	if pr.GetOwnerAgentId() == "" {
		return intervention("Responsible owner missing", "Assign the owning session before routing feedback", 20)
	}

	actionCondition, actionApplies := m.actionDeliveryCondition(pr)
	if actionApplies && actionCondition.group == attentionDeliveries {
		return actionCondition
	}

	mergeCondition, mergeApplies := mergeDeliveryCondition(merge)
	if mergeApplies && mergeCondition.group == attentionDeliveries {
		return mergeCondition
	}

	if repairApplies {
		return repairCondition
	}

	if actionApplies {
		return actionCondition
	}

	// A failed read does not invalidate the retained observation or establish that
	// the coordinator's scheduled retry needs operator intervention.
	if pr.GetRefreshError() != "" {
		return progressing("Observation refresh failed", "Scheduled refresh pending; retained evidence may be stale")
	}

	if pr.GetObservation() == nil {
		return progressing("Awaiting first observation", "The coordinator will inspect GitHub")
	}

	if pr.GetObservation().GetLifecycle() != "open" {
		return progressing("PR state unavailable", "Await a confirmed GitHub lifecycle observation")
	}

	if mergeApplies {
		return mergeCondition
	}

	if !completeDeliveryEvidence(pr.GetObservation()) {
		return progressing("Readiness evidence incomplete", "Wait for complete checks and review observations")
	}

	if checksInProgress(pr.GetObservation()) {
		return progressing("Checks running", "Wait for checks; readiness is assessed separately")
	}

	if pr.GetObservation().GetMergeability() == "conflicting" {
		return progressing("Merge conflict observed", "Await owner assessment of the conflicting revisions")
	}

	return progressing("Monitoring PR", "Await feedback or a guarded merge decision")
}

func mergeDeliveryCondition(merge *v1.MergeStatus) (deliveryCondition, bool) {
	switch merge.GetState() {
	case "waiting":
		if len(merge.GetPrerequisiteUrls()) > 0 {
			return progressing("Waiting for dependencies", "Await confirmed prerequisites, then reassess the candidate"), true
		}

		return progressing("Waiting for merge gates", "The coordinator evaluates the retained evidence"), true
	case "preparing":
		return progressing("Preparing the candidate", "Await preparation and a fresh owner assessment"), true
	case "waiting_owner":
		return progressing("Awaiting owner assessment", "The owning session must assess the current revision"), true
	case "waiting_checks":
		if !merge.GetAutoMerge() {
			return progressing("Waiting for checks", "Inspect checks and saved merge authority; automatic merging is off"), true
		}

		return progressing("Waiting for checks", "The coordinator rechecks eligibility after checks complete"), true
	case "ready":
		if !merge.GetAutoMerge() {
			return progressing("Coordinator marked ready", "Inspect saved merge authority before dispatch; automatic merging is off"), true
		}

		return progressing("Coordinator marked ready", "Await the guarded merge dispatch"), true
	case "merging":
		return progressing("Merge requested", "Await confirmation of the saved operation"), true
	case "blocked":
		return intervention("Merge blocked", "Inspect the coordinator's blocker and next step", 30), true
	case "", "merged", "uncertain", "cancelled":
		return deliveryCondition{}, false
	default:
		return intervention("Merge state unavailable", "Inspect the coordinator's reported state", 30), true
	}
}

func (m *Model) deliveryRepair(pr *v1.TrackedPullRequest) *v1.RepairAttempt {
	var latest *v1.RepairAttempt

	for _, repair := range m.snapshot.GetRepairs() {
		if repair.GetPrId() != pr.GetId() {
			continue
		}

		head := pr.GetObservation().GetHeadSha()
		if repair.GetState() != v1.RepairState_REPAIR_STATE_UNCERTAIN && head != "" && repair.GetOriginalHead() != "" && head != repair.GetOriginalHead() && head != repair.GetResultHead() {
			continue
		}

		if repair.GetState() == v1.RepairState_REPAIR_STATE_FAILED || repair.GetState() == v1.RepairState_REPAIR_STATE_BLOCKED {
			target := pr.GetObservation().GetTargetBase()
			if repair.GetTargetSha() != "" && target.GetSha() != "" && repair.GetTargetSha() != target.GetSha() {
				continue
			}

			if repair.GetTargetRef() != "" && target.GetRef() != "" && repair.GetTargetRef() != target.GetRef() {
				continue
			}
		}

		if latest == nil || repair.GetUpdatedAtMs() > latest.GetUpdatedAtMs() || (repair.GetUpdatedAtMs() == latest.GetUpdatedAtMs() && repair.GetId() > latest.GetId()) {
			latest = repair
		}
	}

	return latest
}

func repairDeliveryCondition(repair *v1.RepairAttempt) (deliveryCondition, bool) {
	switch repair.GetState() {
	case v1.RepairState_REPAIR_STATE_UNCERTAIN:
		return intervention("Repair outcome unknown", "Reconcile the saved repair before another attempt", 2), true
	case v1.RepairState_REPAIR_STATE_BLOCKED:
		return intervention("Repair needs attention", "Inspect the conflict evidence and repair blocker", 25), true
	case v1.RepairState_REPAIR_STATE_FAILED:
		return intervention("Repair failed", "Inspect the failed attempt before requesting another repair", 25), true
	case v1.RepairState_REPAIR_STATE_QUEUED:
		return progressing("Repair queued", "Await the bounded repair attempt"), true
	case v1.RepairState_REPAIR_STATE_RUNNING:
		return progressing("Repair in progress", "Await the repair result and verification"), true
	case v1.RepairState_REPAIR_STATE_AWAITING_CHECKS:
		return progressing("Repair awaiting checks", "Await GitHub verification of the repaired head"), true
	case v1.RepairState_REPAIR_STATE_SUCCEEDED:
		return deliveryCondition{}, false
	case v1.RepairState_REPAIR_STATE_UNSPECIFIED:
		return intervention("Repair state unavailable", "Inspect the retained repair evidence", 25), true
	default:
		return intervention("Repair state unavailable", "Inspect the retained repair evidence", 25), true
	}
}

func (m *Model) actionDeliveryCondition(pr *v1.TrackedPullRequest) (deliveryCondition, bool) {
	var best deliveryCondition

	found := false

	for _, action := range m.snapshot.GetTracking().GetActions() {
		if action.GetPrId() != pr.GetId() || actionHistorical(action, pr) || action.GetCheckResults() != nil {
			continue
		}

		condition := m.ownerActionCondition(action, pr.GetOwnerAgentId())
		if !found || condition.group < best.group || (condition.group == best.group && condition.priority < best.priority) {
			best, found = condition, true
		}
	}

	return best, found
}

func (m *Model) ownerActionCondition(action *v1.PendingAction, owner string) deliveryCondition {
	switch action.GetState() {
	case v1.ActionState_ACTION_STATE_WORKING:
		return progressing("Owner addressing feedback", "Await an assessed candidate and observed resolution")
	case v1.ActionState_ACTION_STATE_ACKNOWLEDGED:
		return progressing("Owner acknowledged feedback", "Await disposition; acknowledgment does not resolve it")
	case v1.ActionState_ACTION_STATE_OPEN:
		return ownerDeliveryCondition(m.latestOwnerDelivery(action.GetId(), owner))
	case v1.ActionState_ACTION_STATE_UNSPECIFIED:
		return intervention("Action state unavailable", "Inspect the retained action before continuing", 20)
	case v1.ActionState_ACTION_STATE_RESOLVED, v1.ActionState_ACTION_STATE_SUPERSEDED:
		return progressing("Feedback disposition recorded", "Await complete GitHub observations")
	default:
		return intervention("Action state unavailable", "Inspect the retained action before continuing", 20)
	}
}

func (m *Model) latestOwnerDelivery(actionID, owner string) *v1.ActionDelivery {
	var latest *v1.ActionDelivery

	for _, delivery := range m.snapshot.GetTracking().GetDeliveries() {
		if delivery.GetActionId() != actionID || delivery.GetRecipientAgentId() != owner {
			continue
		}

		if latest == nil || delivery.GetUpdatedAtMs() > latest.GetUpdatedAtMs() || (delivery.GetUpdatedAtMs() == latest.GetUpdatedAtMs() && delivery.GetId() > latest.GetId()) {
			latest = delivery
		}
	}

	return latest
}

func ownerDeliveryCondition(delivery *v1.ActionDelivery) deliveryCondition {
	if delivery == nil {
		return progressing("Feedback awaiting delivery", "Await routing to the responsible owner")
	}

	switch delivery.GetState() {
	case v1.DeliveryState_DELIVERY_STATE_UNCERTAIN:
		return intervention("Feedback delivery uncertain", "Reconcile delivery before sending the feedback again", 10)
	case v1.DeliveryState_DELIVERY_STATE_UNAVAILABLE:
		return intervention("Owner delivery unavailable", "Inspect the owning session and delivery failure", 20)
	case v1.DeliveryState_DELIVERY_STATE_CANCELLED:
		return intervention("Owner delivery cancelled", "Inspect responsibility before routing the feedback again", 20)
	case v1.DeliveryState_DELIVERY_STATE_DELIVERED:
		if delivery.AcknowledgedAtMs != nil {
			return progressing("Owner received feedback", "Await owner assessment; receipt does not resolve feedback")
		}

		if delivery.MessageSequence == nil {
			return progressing("Feedback delivered; receipt unavailable", "No receipt identifier recorded; await owner assessment")
		}

		return progressing("Feedback delivered", "Await the owner's explicit receipt and assessment")
	case v1.DeliveryState_DELIVERY_STATE_PENDING, v1.DeliveryState_DELIVERY_STATE_SENDING:
		return progressing("Feedback delivery pending", "Await transport confirmation and the owner's receipt")
	case v1.DeliveryState_DELIVERY_STATE_UNSPECIFIED:
		return intervention("Delivery state unavailable", "Inspect the retained delivery evidence", 20)
	default:
		return intervention("Delivery state unavailable", "Inspect the retained delivery evidence", 20)
	}
}

func completeDeliveryEvidence(observation *v1.TrackingObservation) bool {
	return observation.GetHeadSha() != "" &&
		observation.GetTargetBase().GetSha() != "" &&
		observation.GetTargetBase().GetRef() != "" &&
		observationStatus(observation.GetChecks()) == "complete" &&
		observationStatus(observation.GetWorkflows()) == "complete" &&
		observationStatus(observation.GetReviews()) == "complete" &&
		observationStatus(observation.GetFeedback()) == "complete"
}

func checksInProgress(observation *v1.TrackingObservation) bool {
	for _, evidence := range []*v1.DomainCheckEvidence{observation.GetChecks(), observation.GetWorkflows()} {
		for _, check := range evidence.GetVariant_1().GetValue().GetItems() {
			if check.GetHeadSha() == observation.GetHeadSha() && (check.GetStatus() == "queued" || check.GetStatus() == "in_progress" || check.GetStatus() == "pending") {
				return true
			}
		}
	}

	return false
}
