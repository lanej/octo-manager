package tui

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"github.com/lanej/octo-manager/gen/octomanager/v1/octomanagerv1connect"
)

type activityService struct {
	octomanagerv1connect.UnimplementedSchedulerServiceHandler
	cursors chan uint64
	total   uint64
}

func (s activityService) ListActivity(_ context.Context, request *connect.Request[v1.ListActivityRequest]) (*connect.Response[v1.ListActivityResponse], error) {
	cursor := request.Msg.GetAfterSequence()

	total := s.total
	if total == 0 {
		total = 201
	}

	limit := uint64(request.Msg.GetLimit())
	if limit == 0 {
		limit = 200
	}

	first, last := cursor+1, min(cursor+limit, total)
	next, more := last, last < total

	if request.Msg.BeforeSequence != nil {
		cursor = request.Msg.GetBeforeSequence()
		last = min(cursor-1, total)

		first = 1
		if last > limit {
			first = last - limit + 1
		}

		next, more = first, first > 1
		if last == 0 {
			next, more = 0, false
		}
	}

	s.cursors <- cursor

	var entries []*v1.ActivityReport

	for sequence := first; sequence <= last; sequence++ {
		entries = append(entries, &v1.ActivityReport{Sequence: sequence, RecordedAtMs: 1794326090000, Report: &v1.ActivityInput{
			Name: v1.ActivityName_ACTIVITY_NAME_MERGE_PR, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED,
			Actor:  &v1.ActivityActor{Harness: "codex", SessionId: "caller", Version: new("0.167.0")},
			Detail: "Merged Octo PR after checking its exact head", OperationId: "merge-operation-1", PrUrl: new("https://github.com/lanej/octo-manager/pull/2"),
		}})
	}

	if request.Msg.BeforeSequence != nil {
		slices.Reverse(entries)
	}

	return connect.NewResponse(&v1.ListActivityResponse{Activities: entries, NextSequence: next, HasMore: more}), nil
}

func TestAgentActivityPagesWithoutJobsAndFencesReconnect(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	m.instance = "fixture"
	m.snapshot.Sequence = 201
	service := activityService{cursors: make(chan uint64, 4)}
	_, handler := octomanagerv1connect.NewSchedulerServiceHandler(service)
	server := httptest.NewServer(handler)

	t.Cleanup(server.Close)
	m.api.RPC = octomanagerv1connect.NewSchedulerServiceClient(server.Client(), server.URL)

	command := m.Update(tea.KeyPressMsg{Code: '5', Text: "5"})
	if command == nil {
		t.Fatal("activity tab did not load without a job")
	}

	command = m.Update(command())
	if command != nil || len(m.agentActivity.entries) != 50 || <-service.cursors != 202 {
		t.Fatal("opening activity replayed history instead of loading a bounded recent page")
	}

	command = m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})

	if command == nil {
		t.Fatal("older activity was not requested on navigation")
	}

	m.Update(command())

	if len(m.agentActivity.entries) != 50 || m.agentActivity.seenThrough != 201 || <-service.cursors != 152 {
		t.Fatal("activity paging omitted durable reports or used incorrect cursors")
	}

	command = m.Update(tea.KeyPressMsg{Code: 'l', Text: "l"})
	m.Update(command())
	<-service.cursors

	for _, size := range []layout.Size{{Width: 132, Height: 40}, {Width: 80, Height: 32}, {Width: 40, Height: 16}} {
		m.Resize(size)
		view := ansi.Strip(m.View())

		for _, line := range strings.Split(view, "\n") {
			if ansi.StringWidth(line) > size.Width {
				t.Fatalf("activity view exceeds %d columns", size.Width)
			}
		}

		if size.Width >= 80 && (!strings.Contains(view, "Agent activity") || !strings.Contains(view, "success reported")) {
			t.Fatal("activity view omits the named outcome or actor")
		}
	}

	m.snapshot.Sequence = 201
	m.snapshot.Jobs = example().GetJobs()
	m.selected = ""
	m.watching = true
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.panel != activityPanel {
		t.Fatal("a newly arrived PR switched away from global activity")
	}

	m.result.GotoTop()
	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.panel != activityPanel || m.result.YOffset() == 0 {
		t.Fatal("global activity navigation switched to PRs instead of scrolling")
	}

	if m.Update(tea.KeyPressMsg{Code: 'c', Text: "c"}) != nil && m.commandPending {
		t.Fatal("activity navigation issued a hidden job cancellation")
	}

	previousVersion := m.agentActivity.version
	m.instance = "restarted"
	m.snapshot.Sequence = 0
	m.loadActivity()
	m.Update(activityMsg{instance: "fixture", version: previousVersion, entries: []*v1.ActivityReport{{Sequence: 999}}, next: 999})

	if len(m.agentActivity.entries) != 0 {
		t.Fatal("late report from another database instance entered the activity view")
	}

	m.snapshot.Sequence = 1
	m.loadActivity()
	m.Update(activityMsg{instance: m.instance, version: m.agentActivity.version, target: 1, err: errors.New("offline")})

	if !strings.Contains(ansi.Strip(m.activityContent()), "History incomplete") {
		t.Fatal("failed activity reads appear as complete history")
	}
}

func TestActivityOpensLatestLargeHistoryWithoutAutomaticReplay(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.instance = "large-history"
	m.snapshot.Sequence = 120000
	service := activityService{cursors: make(chan uint64, 4), total: 120000}
	_, handler := octomanagerv1connect.NewSchedulerServiceHandler(service)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	m.api.RPC = octomanagerv1connect.NewSchedulerServiceClient(server.Client(), server.URL)

	command := m.Update(tea.KeyPressMsg{Code: '5', Text: "5"})
	if command == nil {
		t.Fatal("activity did not open")
	}

	if followup := m.Update(command()); followup != nil {
		t.Fatal("opening activity automatically requested the older backlog")
	}

	if len(m.agentActivity.entries) != 50 || m.agentActivity.cursor != 120000 || m.agentActivity.oldest != 119951 || !m.agentActivity.hasOlder || <-service.cursors != 120001 {
		t.Fatal("activity did not load only the most recent 50 records")
	}

	if m.loadActivity() != nil || m.agentActivity.loading {
		t.Fatal("unchanged snapshot restarted history loading")
	}

	command = m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})

	if command == nil {
		t.Fatal("older history was unavailable on demand")
	}

	if m.Update(command()) != nil || len(m.agentActivity.entries) != 50 || <-service.cursors != 119951 {
		t.Fatal("older navigation did not load exactly one older page")
	}

	for range 10 {
		command = m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})
		if command == nil {
			t.Fatal("older page unavailable")
		}

		m.Update(command())
		<-service.cursors

		if len(m.agentActivity.entries)+len(m.agentActivity.events) > activityPageSize {
			t.Fatal("page navigation accumulated activity records")
		}
	}

	staleVersion := m.agentActivity.version
	command = m.Update(tea.KeyPressMsg{Code: 'l', Text: "l"})
	m.Update(command())
	<-service.cursors
	m.Update(activityMsg{instance: m.instance, version: staleVersion, before: 120001, next: 1, entries: []*v1.ActivityReport{{Sequence: 1}}})

	if len(m.agentActivity.entries) != activityPageSize {
		t.Fatal("late page replaced current bounded buffer")
	}

	command = m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})
	if command == nil {
		t.Fatal("older request unavailable")
	}

	failedBefore := m.agentActivity.cursors[m.agentActivity.page]
	m.Update(activityMsg{instance: m.instance, version: m.agentActivity.version, before: failedBefore, target: m.snapshot.GetSequence(), err: errors.New("offline")})

	m.snapshot.Sequence++
	if m.loadActivity() != nil || m.agentActivity.loading {
		t.Fatal("new snapshot retried a failed older page")
	}

	command = m.Update(tea.KeyPressMsg{Code: 'u', Text: "u"})
	if command == nil {
		t.Fatal("explicit retry unavailable")
	}

	m.Update(command())

	if <-service.cursors != failedBefore || m.agentActivity.err != nil {
		t.Fatal("explicit retry changed the failed page cursor")
	}

	m.snapshot.Sequence = 120010
	if m.loadActivity() != nil {
		t.Fatal("live refresh moved an older page")
	}
}

func TestActivityWindowRefreshAndVisibleFocus(t *testing.T) {
	// rationale: AllocsPerRun requires the refresh measurement to run without parallel tests.
	m := model(t, theme.Dark)
	m.panel = activityPanel
	m.snapshot.Jobs = nil
	m.snapshot.Sequence = 3000
	m.instance = "fixture"

	m.agentActivity = activityHistory{instance: "fixture", cursor: 3000, seenThrough: 3000, loaded: true}
	for sequence := uint64(2951); sequence <= 3000; sequence++ {
		m.agentActivity.entries = append(m.agentActivity.entries, &v1.ActivityReport{Sequence: sequence, Report: &v1.ActivityInput{
			Name: v1.ActivityName_ACTIVITY_NAME_RUN_CHECKS, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED,
			Actor: &v1.ActivityActor{Harness: "codex", SessionId: "caller"}, Detail: fmt.Sprintf("record-%04d-end", sequence),
		}})
	}

	m.Resize(layout.Size{Width: 132, Height: 40})

	latest := ansi.Strip(m.activitySource())
	if strings.Count(latest, "Run checks") != 50 || !strings.Contains(latest, "record-3000-end") || !strings.Contains(latest, "record-2951-end") || strings.Contains(latest, "record-2950-end") {
		t.Fatal("latest activity window omitted records or rendered outside its bound")
	}

	allocations := testing.AllocsPerRun(3, func() { m.resizeContent() })
	if allocations > 100000 {
		t.Fatalf("unchanged activity refresh rebuilt content: %.0f allocations", allocations)
	}

	m.result.GotoTop()
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m.Update(tea.KeyPressMsg{Code: ']', Text: "]"})

	if m.focus.Current() != "result" || m.result.YOffset() == 0 {
		t.Fatal("Tab moved focus to a hidden pane instead of scrolling Activity")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})

	if m.focus.Current() != "result" {
		t.Fatal("Shift-Tab moved focus to a hidden pane")
	}

	m.applyActivity(activityMsg{instance: m.instance, version: m.agentActivity.version, target: 3000, next: 3000, err: errors.New("offline")})

	if !strings.Contains(m.activitySource(), "History incomplete") {
		t.Fatal("render cache hid an activity read error")
	}

	m.instance = "empty-replacement"
	m.snapshot.Sequence = 0
	m.loadActivity()

	if strings.Contains(m.activitySource(), "record-3000-end") || !strings.Contains(m.activitySource(), "Loading activity") {
		t.Fatal("cached activity survived a database instance replacement")
	}
}

func BenchmarkActivityRefresh(b *testing.B) {
	m := New(context.Background(), nil, theme.New(theme.Dark), time.Local)
	b.Cleanup(m.cancel)
	m.snapshot = &v1.Snapshot{}

	m.panel = activityPanel
	for sequence := uint64(2951); sequence <= 3000; sequence++ {
		m.agentActivity.entries = append(m.agentActivity.entries, &v1.ActivityReport{Sequence: sequence, Report: &v1.ActivityInput{
			Name: v1.ActivityName_ACTIVITY_NAME_RUN_CHECKS, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED,
			Actor: &v1.ActivityActor{Harness: "codex", SessionId: "caller"}, Detail: "Strict TypeScript and Go checks completed successfully.",
		}})
	}

	m.Resize(layout.Size{Width: 132, Height: 40})
	b.ReportAllocs()

	for b.Loop() {
		m.resizeContent()
	}
}

func TestActivityShowsHistoricalActionContextAndLegacyGaps(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.agentActivity.events = []*v1.JobEvent{
		{Sequence: 1, Kind: "action_progress", Detail: "Merge conflict"},
		{Sequence: 2, Kind: "action_progress", Detail: "Merge conflict", ActionContext: &v1.ActionEventContext{State: v1.ActionState_ACTION_STATE_ACKNOWLEDGED, PrUrl: "https://github.com/owner/repo/pull/1", ActorAgentId: new("original"), ActorHarness: new("codex"), ActorSessionId: new("first"), ActorLabel: new("Original owner")}},
	}

	source := ansi.Strip(m.activityContent())
	for _, expected := range []string{"acknowledged", "owner/repo#1", "codex", "Original owner", "Legacy event: transition state and actor were not recorded"} {
		if !strings.Contains(source, expected) {
			t.Fatalf("activity omitted %q", expected)
		}
	}
}

func TestActivityLogKeepsOneLinePerEntry(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	address := "https://github.com/" + strings.Repeat("o", 39) + "/" + strings.Repeat("r", 100) + "/pull/42"
	m.agentActivity.entries = []*v1.ActivityReport{{Sequence: 2, RecordedAtMs: 1794690000000, Report: &v1.ActivityInput{Name: v1.ActivityName_ACTIVITY_NAME_RUN_CHECKS, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_FAILED, Actor: &v1.ActivityActor{Harness: "codex", Label: new("Long working session")}, Detail: strings.Repeat("a long detail ", 40) + "\nsecond physical line\twith tabs", PrUrl: new(address)}}}

	m.agentActivity.events = []*v1.JobEvent{{Sequence: 1, AtMs: 1794690000000, Kind: "scheduler_paused", Detail: "Paused dispatch\nretained jobs"}}
	for _, width := range []int{132, 80, 40} {
		rendered := m.activityContentAt(width)

		lines := strings.Split(ansi.Strip(rendered), "\n")
		if len(lines) != 4 {
			t.Fatalf("%d columns: activity rows wrapped or acquired blank lines: %d", width, len(lines))
		}

		if !strings.Contains(lines[2], "#42") || !strings.Contains(rendered, ansi.SetHyperlink(address)) {
			t.Fatal("narrow log lost the PR number or link destination")
		}

		column := -1

		for _, line := range lines[2:] {
			if ansi.StringWidth(line) > width || strings.ContainsAny(line, "\t\r") {
				t.Fatal("log row exceeded its physical line")
			}

			separator := strings.Index(line, "│")
			if separator < 0 || (column >= 0 && column != separator) {
				t.Fatal("log columns are inconsistent")
			}

			column = separator
		}
	}

	if !strings.Contains(m.activityContent(), "failure reported") || !strings.Contains(m.activityContent(), "second physical line") {
		t.Fatal("single-line formatting lost the outcome or normalized detail")
	}
}
