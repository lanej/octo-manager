package tui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

const savedOperationLimit = 50

type operationHistory struct {
	instance                 string
	version, sequence        uint64
	overview                 *v1.DomainMergeOverview
	selected, pendingID      string
	reconciliation, noticeID string
	loading, loaded          bool
	total                    int
	err                      error
}

type operationsMsg struct {
	instance          string
	version, sequence uint64
	overview          *v1.DomainMergeOverview
	err               error
}

type operationsReconciled struct {
	instance, id string
	result       *v1.DomainReconciliationResult
	err          error
}

type operatorActivityItem struct {
	id        string
	at        int64
	operation *v1.DomainMergeOverviewOperationsItem
	report    *v1.ActivityReport
	event     *v1.JobEvent
}

// Reads are local coordinator inspections, once per changed snapshot or explicit
// refresh. Failed inspections keep the previous evidence until the user retries.
func (m *Model) loadOperations(force bool) tea.Cmd {
	if m.operations.instance != m.instance {
		if m.operations.pendingID != "" {
			m.commandPending = false
		}

		m.operations = operationHistory{instance: m.instance, version: m.operations.version + 1}
		defer m.resizeContent()
	}

	if m.panel != activityPanel || m.instance == "" || m.api == nil {
		return nil
	}

	history := &m.operations
	if history.loading || (!force && (history.err != nil || history.loaded && history.sequence >= m.snapshot.GetSequence())) {
		return nil
	}

	history.loading = true
	history.version++
	instance, version, sequence := m.instance, history.version, m.snapshot.GetSequence()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		response, err := m.api.RPC.InspectMergeChains(ctx, connect.NewRequest(&v1.InspectMergeChainsRequest{}))
		if err != nil {
			return operationsMsg{instance: instance, version: version, sequence: sequence, err: err}
		}

		return operationsMsg{instance: instance, version: version, sequence: sequence, overview: response.Msg.GetOverview()}
	}
}

func (m *Model) applyOperations(msg operationsMsg) tea.Cmd {
	if msg.instance != m.instance || msg.version != m.operations.version {
		return nil
	}

	if msg.err == nil && msg.overview == nil {
		msg.err = errors.New("coordinator returned no operation overview")
	}

	m.operations.loading, m.operations.err = false, msg.err
	if msg.err != nil {
		m.resizeContent()
		return nil
	}

	items := append([]*v1.DomainMergeOverviewOperationsItem(nil), msg.overview.GetOperations().GetItems()...)
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]

		aSelected, bSelected := "operation:"+a.GetId() == m.operations.selected, "operation:"+b.GetId() == m.operations.selected
		if aSelected != bSelected {
			return aSelected
		}

		aUncertain := a.GetState() == v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN

		bUncertain := b.GetState() == v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN
		if aUncertain != bUncertain {
			return aUncertain
		}

		return a.GetUpdatedAt() > b.GetUpdatedAt()
	})

	m.operations.total = len(items)
	m.operations.overview = &v1.DomainMergeOverview{Operations: &v1.DomainMergeOverviewOperations{Items: items[:min(savedOperationLimit, len(items))]}}
	m.operations.sequence, m.operations.loaded = msg.sequence, true
	m.ensureOperationSelection()
	m.resizeContent()

	return m.loadOperations(false)
}

func (m *Model) operatorActivityItems() []operatorActivityItem {
	items := make([]operatorActivityItem, 0, savedOperationLimit+activityPageSize)

	for index, operation := range m.operations.overview.GetOperations().GetItems() {
		id := "operation:" + operation.GetId()
		if operation.GetId() == "" {
			id = fmt.Sprintf("missing-operation:%d", index)
		}

		items = append(items, operatorActivityItem{id: id, at: operation.GetUpdatedAt(), operation: operation})
	}

	activity := activityItems(m.agentActivity)
	for _, item := range activity[:min(activityPageSize, len(activity))] {
		if item.event != nil {
			items = append(items, operatorActivityItem{id: fmt.Sprintf("event:%d", item.sequence), at: item.event.GetAtMs(), event: item.event})
		} else {
			items = append(items, operatorActivityItem{id: fmt.Sprintf("report:%d", item.sequence), at: item.report.GetRecordedAtMs(), report: item.report})
		}
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].at == items[j].at {
			return items[i].id < items[j].id
		}

		return items[i].at > items[j].at
	})

	return items
}

func (m *Model) ensureOperationSelection() {
	items := m.operatorActivityItems()
	for _, item := range items {
		if item.id == m.operations.selected {
			return
		}
	}

	m.operations.selected = ""
	if len(items) > 0 {
		m.operations.selected = items[0].id
	}
}

func (m *Model) selectedOperationItem() operatorActivityItem {
	items := m.operatorActivityItems()
	for _, item := range items {
		if item.id == m.operations.selected {
			return item
		}
	}

	if len(items) > 0 {
		return items[0]
	}

	return operatorActivityItem{}
}

func operationTitle(operation *v1.DomainMergeOverviewOperationsItem) string {
	switch operation.GetKind() {
	case v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_MERGE:
		return "Merge PR"
	case v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_PREPARE:
		return "Prepare branch"
	case v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_UNSPECIFIED:
		return "Unspecified operation"
	default:
		return "Unknown operation"
	}
}

func operationOutcome(state v1.DomainMergeOverviewOperationsItemState) (string, text.Tone) {
	switch state {
	case v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_PLANNED:
		return "Request recorded", text.Neutral
	case v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_RUNNING:
		return "Operation in progress", text.Info
	case v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_SUCCEEDED:
		return "Outcome confirmed", text.Success
	case v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_FAILED:
		return "Operation failed", text.Danger
	case v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN:
		return "Outcome unknown", text.Warning
	case v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNSPECIFIED:
		return "Outcome unavailable", text.Neutral
	default:
		return "Outcome unknown", text.Warning
	}
}

func (m *Model) operationPRURL(operation *v1.DomainMergeOverviewOperationsItem) string {
	for _, pr := range m.snapshot.GetTracking().GetPrs() {
		if pr.GetId() == operation.GetPrId() {
			address, _ := parsePRURL(pr.GetUrl())
			return address
		}
	}

	return ""
}

func (m *Model) currentOperationURL() string {
	item := m.selectedOperationItem()
	if item.operation != nil {
		return m.operationPRURL(item.operation)
	}

	if item.event != nil {
		return m.eventPR(item.event)
	}

	address, _ := parsePRURL(item.report.GetReport().GetPrUrl())

	return address
}

func (m *Model) operationRecordSummary(item operatorActivityItem) layout.RecordSummary {
	record := layout.RecordSummary{Fields: []layout.Pair{{Label: "Recorded", Value: m.timestamp(item.at, briefTimestamp)}}}
	if operation := item.operation; operation != nil {
		status, tone := operationOutcome(operation.GetState())

		record.Title = text.Log(operationTitle(operation), m.theme)
		if subject := m.operationPRURL(operation); subject != "" {
			record.Title = m.link(subject)
			record.Subtitle = text.Label(operationTitle(operation), m.theme)
		}

		record.Status = text.Pill(status, tone, m.theme, text.Normal)

		return record
	}

	if item.event != nil {
		presentation := m.presentEvent(item.event)
		record.Title = text.Log(presentation.title, m.theme)

		record.Subtitle = oneLine(presentation.detail)
		if context := item.event.GetActionContext(); context != nil {
			record.Status = text.Pill(stateName(context.GetState().String(), "ACTION_STATE_"), actionTone(context.GetState()), m.theme, text.Normal)
			record.Fields = append(record.Fields, layout.Pair{Label: "Recorded actor", Value: historicalActionActor(context)})
		} else if item.event.GetKind() == "action_progress" {
			record.Status = text.Pill("Transition unknown", text.Warning, m.theme, text.Normal)
		}

		return record
	}

	report := item.report.GetReport()
	record.Title = text.Log(activityTitle(report.GetName()), m.theme)
	record.Status = text.Pill(activityOutcome(report.GetOutcome()), outcomeTone(report.GetOutcome()), m.theme, text.Normal)

	return record
}

func (m *Model) operationContent(width int) string {
	return m.operationItemContent(m.selectedOperationItem(), width)
}

func (m *Model) operationItemContent(item operatorActivityItem, width int) string {
	return m.operationDocument(item).View(width, m.theme)
}

func (m *Model) operationDocument(item operatorActivityItem) layout.DetailDocument {
	document := layout.DetailDocument{
		Header:  layout.IdentityHeader{ID: "Operation inspection", Context: fmt.Sprintf("History page %d · h older · l newer · u refresh", m.agentActivity.shownPage+1)},
		Summary: m.operationRecordSummary(item),
	}

	document.Summary.Fields = nil
	if item.operation != nil {
		document.Summary.Next = m.operationNext(item.operation)
		document.Sections = m.savedOperationSections(item.operation)
	} else if item.event != nil {
		document.Summary.Subtitle = ""
		document.Sections = []layout.DetailSection{m.eventOperationSection(item.event)}
	} else if item.report != nil {
		document.Sections = []layout.DetailSection{m.reportOperationSection(item.report)}
	} else {
		document.Summary = layout.RecordSummary{}
		document.Sections = []layout.DetailSection{{
			ID: "selection", FullWidth: true,
			Paragraphs: []string{"No operation selected. Saved GitHub effects and the current activity page appear here."},
		}}
	}

	inspection := layout.DetailSection{ID: "inspection", Title: "Inspection status", FullWidth: true}

	if m.operations.loading {
		message := "Loading saved operations."
		if m.operations.loaded {
			message = "Refreshing saved operations; previous evidence retained."
		}

		inspection.Paragraphs = append(inspection.Paragraphs, message)
	}

	if m.operations.err != nil {
		inspection.Statuses = append(inspection.Statuses, layout.StatusItem{
			Label: "Inspection unavailable", Value: text.Pill("u retry", text.Warning, m.theme, text.Normal), Detail: m.operations.err.Error(),
		})
	}

	if m.agentActivity.err != nil {
		inspection.Statuses = append(inspection.Statuses, layout.StatusItem{
			Label: "History incomplete", Value: text.Pill("u retry", text.Warning, m.theme, text.Normal), Detail: m.agentActivity.err.Error(),
		})
	}

	if m.operations.total > savedOperationLimit {
		inspection.Paragraphs = append(inspection.Paragraphs, fmt.Sprintf("Showing %d of %d saved operations; selected and uncertain outcomes retained first.", savedOperationLimit, m.operations.total))
	}

	if m.operations.reconciliation != "" && m.operations.noticeID == item.operation.GetId() {
		inspection.Statuses = append(inspection.Statuses, layout.StatusItem{
			Label: "Reconciliation", Value: text.Pill("Request accepted", text.Info, m.theme, text.Normal), Detail: m.operations.reconciliation,
		})
	}

	if len(inspection.Statuses) > 0 || len(inspection.Paragraphs) > 0 {
		document.Sections = append([]layout.DetailSection{inspection}, document.Sections...)
	}

	return document
}

func (m *Model) eventOperationSection(event *v1.JobEvent) layout.DetailSection {
	presentation := m.presentEvent(event)

	section := layout.DetailSection{
		ID: "event", Title: "Recorded event", FullWidth: true,
		Fields: []layout.Pair{
			{Label: "Source", Value: "Coordinator event"},
			{Label: "Recorded", Value: m.timestamp(event.GetAtMs(), fullTimestamp)},
		},
		Paragraphs: []string{safe(presentation.detail)},
	}
	if context := event.GetActionContext(); context != nil {
		section.Fields = append(section.Fields,
			layout.Pair{Label: "Recorded transition", Value: stateName(context.GetState().String(), "ACTION_STATE_")},
			layout.Pair{Label: "Recorded actor", Value: historicalActionActor(context)},
		)
	} else if event.GetKind() == "action_progress" {
		section.Paragraphs = append(section.Paragraphs, "Legacy event: transition state and actor were not recorded.")
	}

	if presentation.prURL != "" {
		section.Body = m.detailLinks("PR", presentation.prURL)
	}

	return section
}

// Actor identity comes from the historical event; current ownership can change.
func historicalActionActor(context *v1.ActionEventContext) string {
	parts := []string{}
	if context.GetActorHarness() != "" {
		parts = append(parts, safe(context.GetActorHarness()))
	}

	if context.GetActorLabel() != "" || context.GetActorSessionId() != "" {
		parts = append(parts, sessionContext(context.GetActorLabel(), "", context.GetActorSessionId()))
	} else if context.GetActorAgentId() != "" {
		parts = append(parts, "agent "+safe(context.GetActorAgentId()))
	}

	if len(parts) == 0 {
		return "Not recorded"
	}

	return strings.Join(parts, " · ")
}

func (m *Model) savedOperationSections(operation *v1.DomainMergeOverviewOperationsItem) []layout.DetailSection {
	identity := layout.DetailSection{
		ID: "operation", Title: "Operation identity",
		Fields: []layout.Pair{
			{Label: "Operation", Value: operation.GetId()},
			{Label: "Source", Value: "Coordinator operation journal"},
		},
	}
	if address := m.operationPRURL(operation); address != "" {
		identity.Body = m.detailLinks("PR", address)
	} else {
		identity.Fields = append(identity.Fields, layout.Pair{Label: "PR identity", Value: operation.GetPrId()})
	}

	request := layout.DetailSection{
		ID: "request", Title: "Saved request",
		Fields: []layout.Pair{
			{Label: "Requested head", Value: operation.GetHead()},
			{Label: "Target branch", Value: operation.GetBaseRef()},
			{Label: "Phase", Value: stateName(operation.GetPhase().String(), "DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_PHASE_")},
		},
	}
	if operation.GetRequestId() != "" {
		request.Fields = append(request.Fields, layout.Pair{Label: "Saved request", Value: operation.GetRequestId()})
	}

	result := layout.DetailSection{
		ID: "result", Title: "Recorded result", FullWidth: true,
		Paragraphs: []string{operation.GetDetail()},
	}
	if operation.GetResultHead() != "" {
		result.Fields = append(result.Fields, layout.Pair{Label: "Result head", Value: operation.GetResultHead()})
	}

	if operation.GetMergeCommit() != "" {
		result.Fields = append(result.Fields, layout.Pair{Label: "Merge commit", Value: operation.GetMergeCommit()})
	}

	if operation.GetState() == v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_SUCCEEDED {
		result.Paragraphs = append(result.Paragraphs, "The recorded operation outcome does not establish task acceptance.")
	}

	timing := layout.DetailSection{
		ID: "timeline", Title: "Evidence timeline", FullWidth: true,
		Timeline: []layout.TimelineEvent{
			{When: m.timestamp(operation.GetCreatedAt(), fullTimestamp), Title: "Request recorded", Actor: "Coordinator operation journal"},
			{When: m.timestamp(operation.GetUpdatedAt(), fullTimestamp), Title: "Last evidence"},
		},
	}

	return []layout.DetailSection{identity, request, result, timing}
}

func (m *Model) operationNext(operation *v1.DomainMergeOverviewOperationsItem) *layout.Pair {
	if !canReconcileOperation(operation) {
		return nil
	}

	next := "r Reconcile with GitHub · inspect the saved operation without another write."
	if m.operations.pendingID == operation.GetId() {
		next = "Requesting reconciliation; the outcome remains unconfirmed."
	} else if m.operations.err != nil {
		next = "u refresh · inspect saved operations before requesting reconciliation."
	} else if m.commandPending {
		next = "Another command is pending; wait before requesting reconciliation."
	}

	return &layout.Pair{Label: "Next", Value: next}
}

func (m *Model) reportOperationSection(entry *v1.ActivityReport) layout.DetailSection {
	report := entry.GetReport()
	actor := report.GetActor()
	section := layout.DetailSection{
		ID: "report", Title: "Caller report", FullWidth: true,
		Fields: []layout.Pair{
			{Label: "Source", Value: "Caller report · not independent confirmation"},
			{Label: "Actor", Value: actor.GetHarness() + " · " + sessionContext(actor.GetLabel(), actor.GetCwd(), actor.GetSessionId())},
			{Label: "Recorded", Value: m.timestamp(entry.GetRecordedAtMs(), fullTimestamp)},
		},
		Paragraphs: []string{report.GetDetail()},
	}

	switch {
	case report.GetPrUrl() != "" && report.GetEvidenceUrl() != "":
		pr := m.detailLinks("PR", report.GetPrUrl())
		evidence := m.detailLinks("Evidence", report.GetEvidenceUrl())
		section.Body = func(width int) string { return layout.Column(pr(width), evidence(width)) }
	case report.GetPrUrl() != "":
		section.Body = m.detailLinks("PR", report.GetPrUrl())
	case report.GetEvidenceUrl() != "":
		section.Body = m.detailLinks("Evidence", report.GetEvidenceUrl())
	}

	return section
}

func canReconcileOperation(operation *v1.DomainMergeOverviewOperationsItem) bool {
	if operation.GetId() == "" || operation.GetState() != v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN {
		return false
	}

	switch operation.GetKind() {
	case v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_MERGE:
		return operation.GetPhase() == v1.DomainMergeOverviewOperationsItemPhase_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_PHASE_MERGING
	case v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_PREPARE:
		return operation.GetPhase() == v1.DomainMergeOverviewOperationsItemPhase_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_PHASE_PUSHING
	case v1.DomainMergeOverviewOperationsItemKind_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_KIND_UNSPECIFIED:
		return false
	default:
		return false
	}
}

func (m *Model) reconcileOperation() tea.Cmd {
	operation := m.selectedOperationItem().operation
	if m.panel != activityPanel || m.api == nil || m.instance == "" || m.commandPending || m.operations.err != nil || m.operations.instance != m.instance || !canReconcileOperation(operation) {
		return nil
	}

	id, instance := operation.GetId(), m.instance
	m.commandPending, m.operations.pendingID = true, id
	m.commandError, m.operations.reconciliation = "", ""
	m.resizeContent()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		response, err := m.api.RPC.ReconcileMergeOperation(ctx, connect.NewRequest(&v1.ReconcileMergeOperationRequest{Id: new(id)}))
		if err != nil {
			return operationsReconciled{instance: instance, id: id, err: err}
		}

		return operationsReconciled{instance: instance, id: id, result: response.Msg.GetOperation()}
	}
}

func (m *Model) applyOperationReconciled(msg operationsReconciled) tea.Cmd {
	if msg.instance != m.instance || m.operations.pendingID != msg.id {
		return nil
	}

	m.commandPending, m.operations.pendingID = false, ""

	if msg.err == nil && (msg.result == nil || msg.result.GetId() != msg.id) {
		msg.err = errors.New("reconciliation response did not identify the requested operation")
	}

	if msg.err != nil {
		m.commandError = "Reconciliation unavailable: " + safe(msg.err.Error())
		m.resizeContent()

		return nil
	}

	m.operations.noticeID = msg.id
	m.operations.reconciliation = "Request accepted; refresh evidence before treating the operation as confirmed. " + safe(msg.result.GetDetail())
	m.resizeContent()

	return m.loadOperations(true)
}

func (m *Model) operationInput() renderInput {
	history := m.operations
	key := fmt.Sprintf("%s/%d/%d/%s/%t/%t/%v/%s/%s/%s/%d/%d/%d/%t/%v/%t", history.instance, history.version, history.sequence, history.selected, history.loading, history.loaded, history.err, history.pendingID, history.noticeID, history.reconciliation, history.total, m.agentActivity.version, m.agentActivity.shownPage, m.agentActivity.loading, m.agentActivity.err, m.commandPending)

	prs := make([]*v1.TrackedPullRequest, 0, len(m.snapshot.GetTracking().GetPrs()))
	for _, pr := range m.snapshot.GetTracking().GetPrs() {
		prs = append(prs, &v1.TrackedPullRequest{Id: pr.GetId(), Url: pr.GetUrl()})
	}

	actions := make([]*v1.PendingAction, 0, len(m.snapshot.GetTracking().GetActions()))
	for _, action := range m.snapshot.GetTracking().GetActions() {
		actions = append(actions, &v1.PendingAction{Id: action.GetId(), Summary: action.GetSummary()})
	}

	return m.input(key, history.overview, &v1.TrackingSnapshot{Prs: prs, Actions: actions}, &v1.Snapshot{Jobs: m.subjectSnapshot().GetJobs()}, &v1.ListActivityResponse{Activities: m.agentActivity.entries, Events: m.agentActivity.events})
}
