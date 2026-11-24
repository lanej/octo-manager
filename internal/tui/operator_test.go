package tui

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
	"google.golang.org/protobuf/proto"
)

func operatorFixture(t *testing.T) *Model {
	t.Helper()

	m := model(t, theme.Dark)
	fixture, first := deliveryFixture()

	second, ok := proto.Clone(first).(*v1.TrackedPullRequest)
	if !ok {
		t.Fatal("cloning a tracked PR changed its type")
	}

	second.Id, second.Url = "urgent", "https://github.com/owner/repo/pull/2"
	m.snapshot = fixture.snapshot
	m.snapshot.Tracking.Prs = append(m.snapshot.Tracking.Prs, second)
	m.snapshot.MergeStatuses = []*v1.MergeStatus{
		{PrId: first.GetId(), State: "waiting_checks", AutoMerge: true},
		{PrId: second.GetId(), State: "uncertain", AutoMerge: true},
	}
	m.snapshot.Jobs = append(example().GetJobs(), prJob("pr-run", first.GetUrl()))
	m.panel, m.selected = attentionPanel, ""
	m.ensureSelection()
	m.Resize(layout.Size{Width: 132, Height: 40})

	return m
}

func TestOperatorDefaultAndAttentionSelection(t *testing.T) {
	t.Parallel()

	initial := New(context.Background(), nil, theme.New(theme.Dark), time.UTC)
	t.Cleanup(initial.cancel)

	if initial.panel != attentionPanel {
		t.Fatal("dashboard did not start at Attention")
	}

	m := operatorFixture(t)
	if m.currentSubject().tracked.GetId() != "urgent" || m.attentionCount() != 1 {
		t.Fatal("attention did not prioritize the uncertain delivery")
	}

	view := ansi.Strip(m.View())
	if !strings.Contains(view, "Merge outcome unknown") || !strings.Contains(view, "In progress") || strings.Contains(view, "Conflict demo") {
		t.Fatal("Attention hid its next step or included a local worker task")
	}

	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.panel != attentionPanel || m.currentSubject().url != "https://github.com/owner/repo/pull/1" {
		t.Fatal("selection left Attention or ignored the ranked delivery list")
	}

	m.snapshot.Jobs = nil
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.currentSubject().url != "https://github.com/owner/repo/pull/1" {
		t.Fatal("evicting a worker run lost the selected PR")
	}
}

func TestOperatorDetailAndDiagnosticsReturnToContext(t *testing.T) {
	t.Parallel()

	m := operatorFixture(t)
	m.Update(tea.KeyPressMsg{Code: '2', Text: "2"})
	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})

	if m.panel != deliveryPanel || m.detailOrigin != deliveriesPanel {
		t.Fatal("Enter did not inspect the selected delivery")
	}

	address := m.currentSubject().url
	m.Update(tea.KeyPressMsg{Code: 'd', Text: "d"})
	m.Update(tea.KeyPressMsg{Code: '2', Text: "2"})

	if m.panel != outputPanel || m.job().GetId() != "pr-run" {
		t.Fatal("Diagnostics did not make the selected PR's worker output reachable")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyEsc})

	if m.panel != deliveryPanel || m.currentSubject().url != address {
		t.Fatal("Diagnostics lost the inspected PR")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyEsc})

	if m.panel != deliveriesPanel || m.currentSubject().url != address {
		t.Fatal("detail did not return to its originating list")
	}

	m.Update(tea.KeyPressMsg{Code: 'd', Text: "d"})
	m.Update(tea.KeyPressMsg{Code: '3', Text: "3"})
	m.selectSubject(m.subjects()[len(m.subjects())-1])

	if m.currentSubject().url != "" {
		t.Fatal("fixture did not select its local task")
	}

	m.Update(tea.KeyPressMsg{Code: 'd', Text: "d"})

	if m.panel != deliveriesPanel || m.currentSubject().tracked.GetId() != "urgent" {
		t.Fatal("returning from a local task did not repair the delivery selection")
	}
}

func TestDeliveriesKeepSelectedRowVisible(t *testing.T) {
	t.Parallel()

	m := operatorFixture(t)
	_, template := deliveryFixture()
	m.snapshot.Tracking.Prs, m.snapshot.MergeStatuses, m.snapshot.Jobs = nil, nil, nil

	for i := range 24 {
		pr, ok := proto.Clone(template).(*v1.TrackedPullRequest)
		if !ok {
			t.Fatal("cloning a tracked PR changed its type")
		}

		pr.Id = fmt.Sprintf("pr-%02d", i)
		pr.Url = fmt.Sprintf("https://github.com/owner/repo/pull/%d", i+10)
		m.snapshot.Tracking.Prs = append(m.snapshot.Tracking.Prs, pr)
	}

	m.panel, m.selected = deliveriesPanel, ""
	m.ensureSelection()
	m.Resize(layout.Size{Width: 80, Height: 24})

	for range 15 {
		m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})
	}

	if m.result.YOffset() == 0 || !strings.Contains(ansi.Strip(m.View()), m.currentSubject().label) {
		t.Fatal("the selected delivery scrolled outside the visible list")
	}

	for range 15 {
		m.Update(tea.KeyPressMsg{Code: 'k', Text: "k"})
	}

	if !strings.Contains(ansi.Strip(m.View()), m.currentSubject().label) {
		t.Fatal("reverse navigation did not reveal the selected delivery")
	}
}

func TestOperatorEvidenceChangesInvalidateRetainedViews(t *testing.T) {
	t.Parallel()

	m := operatorFixture(t)
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	before := m.PresentationRevision()
	m.snapshot.MergeStatuses[1].State = "blocked"
	m.snapshot.MergeStatuses[1].Detail = "Owner approval required"
	m.resizeContent()

	if m.PresentationRevision() == before || !strings.Contains(ansi.Strip(m.View()), "Merge blocked") {
		t.Fatal("a changed merge condition stayed hidden behind a retained frame")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyEsc})

	address := "https://github.com/owner/repo/pull/1"
	m.reviews[address] = &v1.PullRequestDetails{Url: address, Title: "Fix callback ordering"}
	m.resizeContent()

	if !strings.Contains(ansi.Strip(m.View()), "Fix callback ordering") {
		t.Fatal("newly cached PR identity did not update the attention rail")
	}
}

func TestOperationInspectionRefreshesRetainedNavigationHelp(t *testing.T) {
	t.Parallel()

	m := operatorFixture(t)
	m.panel = activityPanel
	operation := operatorTestOperation("merge-request", v1.DomainMergeOverviewOperationsItemState_DOMAIN_MERGE_OVERVIEW_OPERATIONS_ITEM_STATE_UNCERTAIN)
	m.operations = operationHistory{overview: operatorTestOverview(operation), selected: "operation:merge-request"}
	m.resizeContent()
	m.View()
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})

	if !m.inspectingOperation() || !strings.Contains(ansi.Strip(m.View()), "j/k scroll") {
		t.Fatal("inspection retained selection help while keys scroll evidence")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyEsc})

	if m.inspectingOperation() || !strings.Contains(ansi.Strip(m.View()), "j/k select") {
		t.Fatal("returning to the list retained inspection help")
	}
}

func TestOperatorWorkspaceReflowsBetweenListAndPreview(t *testing.T) {
	t.Parallel()

	m := operatorFixture(t)
	for _, width := range []int{80, 124, 80} {
		m.Resize(layout.Size{Width: width, Height: 32})

		split := width > 100
		if m.currentWorkspace().Split() != split || strings.Contains(ansi.Strip(m.resultContent), "DELIVERY DETAIL") != split {
			t.Fatal("resizing retained the other layout's inspector allocation")
		}
	}
}
