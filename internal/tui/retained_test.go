package tui

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/runtime"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"google.golang.org/protobuf/proto"
)

type observedScene struct {
	*Model
	frames int
}

func (s *observedScene) View() string { s.frames++; return s.Model.View() }

func TestRetainedRuntimeNoopAndLatestFrame(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.panel = outputPanel
	scene := &observedScene{Model: m}

	root := &runtime.Root{Scene: scene, Size: layout.Size{Width: 132, Height: 40}}
	if err := root.PresentNow(); err != nil {
		t.Fatal(err)
	}

	first := root.View().Content
	revision := m.PresentationRevision()
	m.Update(snapshotMsg{snapshot: proto.CloneOf(m.snapshot)})

	if m.PresentationRevision() != revision {
		t.Fatal("equal observation changed presentation")
	}

	if _, cmd := root.Update(struct{}{}); cmd != nil {
		t.Fatal("no-op update scheduled a frame")
	}

	for _, text := range []string{"Intermediate result", "Newest result"} {
		snapshot := proto.CloneOf(m.snapshot)
		snapshot.Jobs[0].ResultMarkdown = new(text)
		root.Update(snapshotMsg{snapshot: snapshot})
	}

	if root.View().Content != first || scene.frames != 1 {
		t.Fatal("updates eagerly presented instead of retaining the completed frame")
	}

	if err := root.PresentNow(); err != nil {
		t.Fatal(err)
	}

	if scene.frames != 2 || !strings.Contains(ansi.Strip(root.View().Content), "Newest result") {
		t.Fatal("coalesced frame lost the newest observation")
	}
}

func TestUnrelatedBudgetObservationDoesNotPresentWorkerPane(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.Resize(layout.Size{Width: 132, Height: 40})
	before := m.PresentationRevision()
	m.snapshot.GithubUsage = usageExample()
	m.snapshot.Sequence++
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.PresentationRevision() != before {
		t.Fatal("hidden budget observation invalidated worker presentation")
	}
}

func TestRetainedWorkerScrollAndChrome(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)

	m.panel = outputPanel
	for i := range 30 {
		m.snapshot.RecentEvents = append(m.snapshot.RecentEvents, &v1.JobEvent{JobId: m.selected, Sequence: uint64(100 + i), Kind: "tool", Detail: "retained tool entry"})
	}

	m.Resize(layout.Size{Width: 132, Height: 40})
	m.View()
	m.focus.Set("activity")
	m.key(tea.KeyPressMsg{Code: '[', Text: "["})
	offset := m.activity.YOffset()
	before := m.View()
	m.Update(snapshotMsg{snapshot: proto.CloneOf(m.snapshot)})

	if m.activity.YOffset() != offset || m.View() != before {
		t.Fatal("equal snapshot reset native scrolling or visible content")
	}

	m.snapshot.RecoveryPid = new(int64(54321))
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if !strings.Contains(ansi.Strip(m.View()), "54321") {
		t.Fatal("retained worker header hid recovery state")
	}

	m.Update(commandMsg{err: errors.New("visible failure")})

	if !strings.Contains(ansi.Strip(m.View()), "visible failure") {
		t.Fatal("retained notice hid command failure")
	}

	m.Resize(layout.Size{Width: 12, Height: 5})

	if m.focus.Current() != "result" || !strings.Contains(ansi.Strip(m.View()), "q quit") {
		t.Fatal("recovery layout lost focus escape or quit control")
	}
}

func TestPreparedMarkdownAcrossResize(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.Resize(layout.Size{Width: 132, Height: 40})

	document := m.contentRender.document
	if document == nil {
		t.Fatal("Markdown was not prepared")
	}

	m.Resize(layout.Size{Width: 80, Height: 32})

	if m.contentRender.document != document {
		t.Fatal("resize reparsed unchanged Markdown")
	}

	if !strings.Contains(ansi.Strip(m.View()), "Combined policy") {
		t.Fatal("resize lost worker result")
	}

	m.snapshot.Jobs[0].ResultMarkdown = new("Replacement Markdown")
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.contentRender.document == document || !strings.Contains(ansi.Strip(m.View()), "Replacement Markdown") {
		t.Fatal("prepared document concealed changed source")
	}
}

func TestSchedulerTickRetainsGitHubSource(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.panel = githubPanel
	m.snapshot.GithubUsage = usageExample()
	m.snapshot.GithubScheduler = &v1.GitHubSchedulerStatus{TickMs: 1000, RequestSpacingMs: 2000}
	m.Update(snapshotMsg{snapshot: m.snapshot})
	m.Resize(layout.Size{Width: 132, Height: 40})
	before := m.View()
	prepared := m.memo("pane-source").revision
	revision := m.PresentationRevision()
	m.snapshot.GithubScheduler.TickSequence++
	m.snapshot.GithubScheduler.NextTickAtMs = 1234
	m.snapshot.GithubScheduler.NextDispatchAtMs = 5678
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.memo("pane-source").revision != prepared || m.PresentationRevision() != revision || m.View() != before {
		t.Fatal("undisplayed tick state rebuilt GitHub content")
	}

	m.snapshot.GithubScheduler.QueuedRequests = 1
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if !strings.Contains(ansi.Strip(m.View()), "1 queued") {
		t.Fatal("visible scheduler queue change was suppressed")
	}
}
