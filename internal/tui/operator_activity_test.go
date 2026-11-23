package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
	"github.com/lanej/octo-manager/gen/octomanager/v2/octomanagerv2connect"
)

type operationRPCStub struct {
	octomanagerv2connect.SchedulerServiceClient
	overview       *v1.DomainMergeOverview
	inspectError   error
	inspections    int
	reconciled     []string
	reconciliation *v1.DomainReconciliationResult
}

func (s *operationRPCStub) InspectMergeChains(_ context.Context, _ *connect.Request[v1.InspectMergeChainsRequest]) (*connect.Response[v1.InspectMergeChainsResponse], error) {
	s.inspections++
	if s.inspectError != nil {
		return nil, s.inspectError
	}

	return connect.NewResponse(&v1.InspectMergeChainsResponse{Overview: s.overview}), nil
}

func (s *operationRPCStub) ReconcileMergeOperation(_ context.Context, request *connect.Request[v1.ReconcileMergeOperationRequest]) (*connect.Response[v1.ReconcileMergeOperationResponse], error) {
	s.reconciled = append(s.reconciled, request.Msg.GetId())

	return connect.NewResponse(&v1.ReconcileMergeOperationResponse{Operation: s.reconciliation}), nil
}

func operatorTestOperation(id string, state v1.DomainMergeOverviewOperationsItemState) *v1.DomainMergeOverviewOperationsItem {
	return &v1.DomainMergeOverviewOperationsItem{
		Id: new(id), PrId: new("pr"), Kind: v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_MERGE.Enum(),
		State: state.Enum(), Phase: v1.DomainMergeOverviewOperationsItemPhase_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_PHASE_MERGING.Enum(),
		Head: new(strings.Repeat("a", 40)), BaseRef: new("main"), CreatedAt: new(int64(1000)), UpdatedAt: new(int64(2000)),
		Detail: new("Remote response was lost; the original operation is retained."),
	}
}

func operatorTestOverview(operations ...*v1.DomainMergeOverviewOperationsItem) *v1.DomainMergeOverview {
	return &v1.DomainMergeOverview{Operations: &v1.DomainMergeOverviewOperations{Items: operations}}
}

func TestOperatorActivityRefreshPreservesEvidenceAndFencesLateResults(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel, m.instance = activityPanel, "instance"
	m.snapshot.Sequence = 12
	op := operatorTestOperation("merge-original", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	service := &operationRPCStub{overview: operatorTestOverview(op)}
	m.api.RPC = service

	command := m.loadOperations(false)
	if command == nil || m.loadOperations(false) != nil {
		t.Fatal("initial inspection did not start exactly once")
	}

	message, ok := command().(operationsMsg)
	if !ok {
		t.Fatal("inspection returned an unexpected message")
	}

	if m.applyOperations(message) != nil || service.inspections != 1 || m.operations.selected != "operation:merge-original" {
		t.Fatal("inspection did not select the saved operation")
	}

	if m.loadOperations(false) != nil {
		t.Fatal("unchanged snapshot triggered another local inspection")
	}

	m.snapshot.Sequence = 13
	service.inspectError = errors.New("coordinator unavailable")
	command = m.loadOperations(false)

	message, ok = command().(operationsMsg)
	if !ok {
		t.Fatal("failed inspection returned an unexpected message")
	}

	m.applyOperations(message)

	if m.operations.selected != "operation:merge-original" || m.operations.overview.GetOperations().GetItems()[0].GetHead() != op.GetHead() {
		t.Fatal("a failed inspection discarded the last known target")
	}

	content := ansi.Strip(m.operationContent(80))
	if !strings.Contains(content, "Inspection unavailable") || !strings.Contains(content, "Outcome unknown") {
		t.Fatal("retained evidence hid its failed refresh or uncertain outcome")
	}

	if !strings.Contains(content, "u refresh · inspect saved operations before requesting reconciliation.") || strings.Contains(content, "r Reconcile") {
		t.Fatal("failed inspection offered reconciliation before refreshing its evidence")
	}

	if m.loadOperations(false) != nil || m.reconcileOperation() != nil {
		t.Fatal("failed inspection silently retried or authorized an action")
	}

	version := m.operations.version
	m.applyOperations(operationsMsg{instance: "instance", version: version - 1, overview: &v1.DomainMergeOverview{}})

	if m.operations.selected == "" {
		t.Fatal("a stale request replaced the retained selection")
	}

	m.instance = "replacement"
	m.loadOperations(false)
	m.applyOperations(operationsMsg{instance: "instance", version: version, overview: service.overview})

	if m.operations.overview != nil {
		t.Fatal("evidence crossed coordinator instances")
	}
}

func TestOperatorActivityReconcilesOnlyTheSelectedSavedRequest(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel, m.instance = activityPanel, "instance"
	first := operatorTestOperation("merge-original", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	second := operatorTestOperation("merge-other", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	m.operations = operationHistory{instance: m.instance, loaded: true, overview: operatorTestOverview(first, second), selected: "operation:merge-original"}
	service := &operationRPCStub{
		overview: m.operations.overview,
		reconciliation: &v1.DomainReconciliationResult{
			Id: new("merge-original"), State: v1.DomainReconciliationResultState_DOMAIN_RECONCILIATION_RESULT_STATE_UNCERTAIN.Enum(),
			Detail: new("Reconciliation queued; no operation will be replayed"),
		},
	}
	m.api.RPC = service

	command := m.reconcileOperation()
	if command == nil || m.reconcileOperation() != nil {
		t.Fatal("reconciliation was absent or duplicated while pending")
	}

	if !strings.Contains(ansi.Strip(m.operationContent(80)), "Requesting reconciliation; the outcome remains unconfirmed.") {
		t.Fatal("pending reconciliation lost its unconfirmed outcome guidance")
	}

	m.operations.selected = "operation:merge-other"

	content := ansi.Strip(m.operationContent(80))
	if !strings.Contains(content, "Another command is pending") || strings.Contains(content, "r Reconcile") || m.reconcileOperation() != nil {
		t.Fatal("another operation offered reconciliation while the original request remained pending")
	}

	response, ok := command().(operationsReconciled)
	if !ok {
		t.Fatal("reconciliation returned an unexpected message")
	}

	refresh := m.applyOperationReconciled(response)
	if len(service.reconciled) != 1 || service.reconciled[0] != "merge-original" || refresh == nil {
		t.Fatal("reconciliation lost the exact saved operation or its evidence refresh")
	}

	if first.GetState() != v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN || m.commandPending || m.operations.selected != "operation:merge-other" {
		t.Fatal("request acceptance changed an outcome or overwrote newer selection")
	}

	if strings.Contains(ansi.Strip(m.operationContent(80)), "Reconciliation queued") {
		t.Fatal("one operation's request receipt appeared under a different operation")
	}

	m.operations.selected = "operation:merge-original"
	if !strings.Contains(ansi.Strip(m.operationContent(80)), "Outcome unknown") {
		t.Fatal("queued reconciliation was presented as a confirmed merge")
	}

	m.operations.pendingID, m.commandPending = "merge-other", true
	m.applyOperationReconciled(response)

	if !m.commandPending || m.operations.pendingID != "merge-other" {
		t.Fatal("late response cleared a different in-flight command")
	}
}

func TestOperatorActivityPendingCommandRefreshesReconciliationHelp(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel, m.instance = activityPanel, "instance"
	op := operatorTestOperation("merge-original", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	m.operations = operationHistory{instance: m.instance, loaded: true, overview: operatorTestOverview(op), selected: "operation:merge-original"}
	m.Resize(layout.Size{Width: 160, Height: 50})

	if !strings.Contains(ansi.Strip(m.resultContent), "r Reconcile with GitHub") {
		t.Fatal("eligible saved operation lost its reconciliation guidance")
	}

	m.commandPending = true
	m.resizeContent()

	content := ansi.Strip(m.resultContent)
	if !strings.Contains(content, "Another command is pending") || strings.Contains(content, "r Reconcile") || m.reconcileOperation() != nil {
		t.Fatal("retained operation help ignored a different pending command")
	}

	m.commandPending = false
	m.resizeContent()

	content = ansi.Strip(m.resultContent)
	if !strings.Contains(content, "r Reconcile with GitHub") || strings.Contains(content, "Another command is pending") {
		t.Fatal("retained operation help did not recover when the command completed")
	}
}

func TestOperatorActivityRejectsMismatchedReconciliationReceipt(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel, m.instance = activityPanel, "instance"
	m.commandPending = true
	m.operations = operationHistory{instance: m.instance, pendingID: "saved-operation"}

	command := m.applyOperationReconciled(operationsReconciled{instance: m.instance, id: "saved-operation", result: &v1.DomainReconciliationResult{Id: new("different-operation")}})
	if command != nil || m.commandPending || !strings.Contains(m.commandError, "did not identify") {
		t.Fatal("mismatched operation receipt was accepted")
	}
}

func TestOperatorActivityReplacementClearsPendingRequestOutsideActivity(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel, m.instance = activityPanel, "original"
	op := operatorTestOperation("merge-original", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	m.operations = operationHistory{instance: "original", overview: operatorTestOverview(op), selected: "operation:merge-original", loaded: true}
	service := &operationRPCStub{reconciliation: &v1.DomainReconciliationResult{Id: new("merge-original")}}
	m.api.RPC = service

	command := m.reconcileOperation()
	if command == nil || !m.commandPending {
		t.Fatal("saved operation reconciliation did not become pending")
	}

	m.panel, m.instance = deliveryPanel, "replacement"

	refresh := m.loadOperations(false)
	if refresh != nil || m.commandPending || m.operations.pendingID != "" || m.operations.overview != nil {
		t.Fatal("coordinator replacement left an old operation pending outside Activity")
	}

	m.commandPending = true

	response, ok := command().(operationsReconciled)
	if !ok {
		t.Fatal("reconciliation returned an unexpected message")
	}

	m.applyOperationReconciled(response)

	if !m.commandPending || m.operations.reconciliation != "" {
		t.Fatal("old coordinator response changed replacement command state")
	}
}

func TestOperatorActivityReplacementClearsRenderedEvidenceImmediately(t *testing.T) {
	t.Parallel()

	for _, panel := range []panelView{activityPanel, deliveryPanel} {
		t.Run(tabDefinition(panel).id, func(t *testing.T) {
			t.Parallel()

			m := model(t, theme.Dark)
			m.panel, m.instance = activityPanel, "original"
			op := operatorTestOperation("merge-original", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_SUCCEEDED)
			m.operations = operationHistory{instance: "original", overview: operatorTestOverview(op), selected: "operation:merge-original", loaded: true}
			m.api.RPC = &operationRPCStub{}
			m.Resize(layout.Size{Width: 132, Height: 40})

			if !strings.Contains(ansi.Strip(m.resultContent), "merge-original") {
				t.Fatal("fixture did not retain the original coordinator's operation")
			}

			m.panel = panel
			m.Update(snapshotMsg{snapshot: &v1.Snapshot{InstanceId: "replacement", Sequence: 1}})

			if m.operations.overview != nil || strings.Contains(ansi.Strip(m.resultContent), "merge-original") || strings.Contains(ansi.Strip(m.View()), "Outcome confirmed") {
				t.Fatal("coordinator replacement retained old operation evidence before the next response")
			}

			if panel == activityPanel && !strings.Contains(ansi.Strip(m.resultContent), "Loading saved operations") {
				t.Fatal("replacement inspection did not render its loading state immediately")
			}
		})
	}
}

func TestOperatorActivityKeepsReportsSeparateFromConfirmedOperations(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel = activityPanel
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/42"}}}
	op := operatorTestOperation("merge-confirmed", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_SUCCEEDED)
	op.Detail = new("PR now merged; original merge attribution remains uncertain")
	m.operations = operationHistory{overview: operatorTestOverview(op), selected: "operation:merge-confirmed"}
	m.agentActivity = activityHistory{
		shownPage: 2,
		entries: []*v1.ActivityReport{{
			Sequence: 100, RecordedAtMs: 4000,
			Report: &v1.ActivityInput{Name: v1.ActivityName_ACTIVITY_NAME_MERGE_PR, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED, Detail: "Merged PR", PrUrl: new("https://github.com/owner/repo/pull/42"), Actor: &v1.ActivityActor{Harness: "pi", SessionId: "worker"}},
		}},
		events: []*v1.JobEvent{{Sequence: 101, AtMs: 5000, Kind: "delivery_delivered", PrId: new("pr")}},
	}

	content := ansi.Strip(m.operationContent(80))
	for _, want := range []string{"Outcome confirmed", "attribution remains uncertain", "Requested head", "History page 3"} {
		if !strings.Contains(content, want) {
			t.Errorf("saved operation omitted %q", want)
		}
	}

	m.operations.selected = "report:100"

	content = ansi.Strip(m.operationContent(80))
	if !strings.Contains(content, "success reported") || !strings.Contains(content, "not independent confirmation") || strings.Contains(content, "Outcome confirmed") {
		t.Fatal("caller report was confused with a verified external effect")
	}

	m.operations.selected = "event:101"

	content = strings.Join(strings.Fields(ansi.Strip(m.operationContent(80))), " ")
	if !strings.Contains(content, "receipt and acknowledgment are unverified") {
		t.Fatal("coordinator delivery event lost its receipt distinction")
	}

	if m.currentOperationURL() != "https://github.com/owner/repo/pull/42" {
		t.Fatal("operation navigation lost the associated PR")
	}

	for _, width := range []int{42, 24, 12} {
		m.resizeOperatorWorkspace(layout.Size{Width: width, Height: 13})

		for _, line := range strings.Split(m.resultContent, "\n") {
			if ansi.StringWidth(line) > width {
				t.Fatalf("operation list overflowed %d columns", width)
			}
		}
	}
}

func TestOperatorActivityBoundsRetainedHistoryAndPrioritizesUncertainty(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel, m.instance = activityPanel, "instance"
	m.operations = operationHistory{instance: m.instance, version: 1}
	operations := make([]*v1.DomainMergeOverviewOperationsItem, 0, 101)

	for index := range 100 {
		op := operatorTestOperation(fmt.Sprintf("done-%d", index), v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_SUCCEEDED)
		op.UpdatedAt = new(int64(index + 10))
		operations = append(operations, op)
	}

	uncertain := operatorTestOperation("older-uncertain", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	uncertain.UpdatedAt = new(int64(1))
	operations = append(operations, uncertain)
	m.applyOperations(operationsMsg{instance: m.instance, version: 1, overview: operatorTestOverview(operations...)})

	retained := m.operations.overview.GetOperations().GetItems()
	if len(retained) != savedOperationLimit || retained[0].GetId() != "older-uncertain" {
		t.Fatal("bounded operation inspection discarded an unresolved outcome first")
	}

	if !strings.Contains(ansi.Strip(m.operationContent(80)), "Showing 50 of 101") {
		t.Fatal("bounded history was silently presented as complete")
	}

	m.operations.selected = "operation:older-uncertain"
	m.applyOperations(operationsMsg{instance: m.instance, version: 1, overview: operatorTestOverview(uncertain)})

	if m.operations.selected != "operation:older-uncertain" {
		t.Fatal("refresh did not preserve the selected operation by identity")
	}

	m.operations.selected = "operation:done-0"
	m.applyOperations(operationsMsg{instance: m.instance, version: 1, overview: operatorTestOverview(operations...)})

	if m.operations.selected != "operation:done-0" || m.selectedOperationItem().operation.GetId() != "done-0" {
		t.Fatal("bounded refresh discarded an older selected operation that still exists")
	}
}

func TestOperatorActivityOnlyOffersExternalUncertaintyReconciliation(t *testing.T) {
	t.Parallel()

	op := operatorTestOperation("merge", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	if !canReconcileOperation(op) {
		t.Fatal("uncertain saved merge cannot be reconciled")
	}

	op.State = v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_RUNNING.Enum()
	if canReconcileOperation(op) {
		t.Fatal("running operation exposed an uncertainty-only action")
	}

	op.State = v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN.Enum()
	op.Kind = v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_PREPARE.Enum()

	op.Phase = v1.DomainMergeOverviewOperationsItemPhase_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_PHASE_LOCAL.Enum()
	if canReconcileOperation(op) {
		t.Fatal("local preparation was treated as an uncertain GitHub write")
	}

	op.Phase = v1.DomainMergeOverviewOperationsItemPhase_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_PHASE_PUSHING.Enum()
	if !canReconcileOperation(op) {
		t.Fatal("uncertain preparation push lost reconciliation")
	}

	op.Id = nil
	if canReconcileOperation(op) {
		t.Fatal("reconciliation was offered without a saved operation ID")
	}
}

func TestOperatorActivityMemoTracksEventReferences(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel = activityPanel
	m.snapshot.Jobs = []*v1.Job{prJob("worker", "https://github.com/owner/repo/pull/1")}
	m.snapshot.Tracking = &v1.TrackingSnapshot{Actions: []*v1.PendingAction{{Id: "notification", Summary: "Original blocker"}}}
	m.agentActivity.events = []*v1.JobEvent{{Sequence: 10, Kind: "delivery_delivered", JobId: "worker", ActionId: new("notification")}}
	m.operations.selected = "event:10"
	cache := renderMemo{}
	render := func() string { return m.operationContent(80) }

	initial := cache.render(m.operationInput(), render)
	if !strings.Contains(ansi.Strip(initial), "Original blocker") || !strings.Contains(ansi.Strip(initial), "owner/repo#1") {
		t.Fatal("operation inspector did not resolve current event references")
	}

	revision := cache.revision
	cache.render(m.operationInput(), render)

	if cache.revision != revision {
		t.Fatal("unchanged evidence invalidated operation presentation")
	}

	m.snapshot.Jobs[0].Task = prJob("worker", "https://github.com/owner/repo/pull/2").GetTask()
	m.snapshot.Tracking.Actions[0].Summary = "Replacement blocker"

	changed := ansi.Strip(cache.render(m.operationInput(), render))
	if !strings.Contains(changed, "Replacement blocker") || !strings.Contains(changed, "owner/repo#2") || strings.Contains(changed, "Original blocker") {
		t.Fatal("changed event references left the operation inspector stale")
	}
}

func TestOperatorActivityPreservesHistoricalActionContextAndLegacyGaps(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.panel = activityPanel
	m.snapshot.Jobs = nil
	m.snapshot.Tracking = &v1.TrackingSnapshot{
		Prs:     []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/2", OwnerAgentId: "replacement"}},
		Actions: []*v1.PendingAction{{Id: "action", PrId: "pr", OwnerAgentId: "replacement", State: v1.ActionState_ACTION_STATE_RESOLVED}},
		Agents:  []*v1.AgentReference{{Id: "replacement", Target: &v1.AgentTarget{Harness: "pi", SessionId: "new", Label: new("Current owner")}}},
	}
	legacy := &v1.JobEvent{Sequence: 1, AtMs: 1000, Kind: "action_progress", Detail: "Merge conflict", PrId: new("pr"), ActionId: new("action")}
	recorded := &v1.JobEvent{
		Sequence: 2, AtMs: 2000, Kind: "action_progress", Detail: "Merge conflict", PrId: new("pr"), ActionId: new("action"),
		ActionContext: &v1.ActionEventContext{
			State: v1.ActionState_ACTION_STATE_ACKNOWLEDGED, PrUrl: "https://github.com/owner/repo/pull/1",
			ActorAgentId: new("original"), ActorHarness: new("codex"), ActorSessionId: new("first"), ActorLabel: new("Original owner"),
		},
	}
	m.agentActivity.events = []*v1.JobEvent{legacy, recorded}
	m.operations.selected = "event:2"

	content := ansi.Strip(m.operationContent(132))
	for _, want := range []string{"Recorded transition: acknowledged", "Recorded actor: codex · Original owner", "owner/repo#1"} {
		if !strings.Contains(content, want) {
			t.Errorf("historical action omitted %q in:\n%s", want, content)
		}
	}

	if strings.Contains(content, "Current owner") || strings.Contains(content, "Recorded transition: resolved") {
		t.Fatal("current action ownership or disposition replaced historical evidence")
	}

	_, detail := m.operationRow(operatorActivityItem{event: recorded})
	if !strings.Contains(ansi.Strip(detail), "acknowledged") || !strings.Contains(ansi.Strip(detail), "Original owner") {
		t.Fatal("activity row omitted the recorded transition and actor")
	}

	m.operations.selected = "event:1"
	content = ansi.Strip(m.operationContent(132))

	if !strings.Contains(content, "Legacy event: transition state and actor were not recorded") || strings.Contains(content, "Original owner") || strings.Contains(content, "Recorded transition: resolved") {
		t.Fatal("legacy event gaps were hidden or filled using current action state")
	}

	_, detail = m.operationRow(operatorActivityItem{event: legacy})
	if !strings.Contains(detail, "Transition unknown") {
		t.Fatal("legacy activity row implied a known transition")
	}
}
