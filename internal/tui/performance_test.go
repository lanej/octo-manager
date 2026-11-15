package tui

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/runtime"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"github.com/lanej/octo-manager/internal/client"
	"google.golang.org/protobuf/proto"
)

func benchmarkDashboard(b *testing.B, panel panelView) *Model {
	b.Helper()

	m := New(context.Background(), client.New("/nonexistent/octo-manager.sock"), theme.New(theme.Dark), time.UTC)

	b.Cleanup(func() {
		if err := m.Close(); err != nil {
			b.Error(err)
		}
	})

	m.snapshot = example()
	m.snapshot.GithubUsage = usageExample()
	m.snapshot.GithubScheduler = &v1.GitHubSchedulerStatus{TickMs: 1000, RequestSpacingMs: 2000}
	m.snapshot.Tracking = &v1.TrackingSnapshot{}

	for i := range 30 {
		address := fmt.Sprintf("https://github.com/example/project/pull/%d", i+1)
		id := fmt.Sprintf("pr-%d", i)
		m.snapshot.Tracking.Prs = append(m.snapshot.Tracking.Prs, &v1.TrackedPullRequest{Id: id, Url: address, Enabled: true})
	}

	m.snapshot.Jobs = []*v1.Job{prJob("run", m.snapshot.Tracking.Prs[0].GetUrl())}

	m.snapshot.Jobs[0].ResultMarkdown = new(strings.Repeat("## Result\n\nA paragraph with **visible state**.\n\n```go\nfunc ready() bool { return true }\n```\n\n", 25))
	for i := range 100 {
		m.snapshot.RecentEvents = append(m.snapshot.RecentEvents, &v1.JobEvent{Sequence: uint64(i + 1), JobId: "run", Kind: "tool", Detail: "read_conflict", AtMs: 1000})
	}

	m.ensureSelection()
	m.panel = panel
	m.Resize(layout.Size{Width: 132, Height: 40})

	return m
}

func BenchmarkDashboardSnapshots(b *testing.B) {
	for _, panel := range []panelView{reviewsPanel, outputPanel, statePanel, trackingPanel, activityPanel, githubPanel} {
		b.Run(tabDefinition(panel).id, func(b *testing.B) {
			m := benchmarkDashboard(b, panel)
			b.ReportAllocs()

			for b.Loop() {
				m.Update(snapshotMsg{snapshot: proto.CloneOf(m.snapshot)})

				if m.View() == "" {
					b.Fatal("empty dashboard")
				}
			}
		})
	}
}

func BenchmarkDashboardResize(b *testing.B) {
	m := benchmarkDashboard(b, outputPanel)
	b.ReportAllocs()

	for b.Loop() {
		for _, width := range []int{80, 132} {
			m.Resize(layout.Size{Width: width, Height: 40})

			if m.View() == "" {
				b.Fatal("empty dashboard")
			}
		}
	}
}

func BenchmarkDashboardIdleView(b *testing.B) {
	m := benchmarkDashboard(b, trackingPanel)
	root := &runtime.Root{Scene: m, Size: layout.Size{Width: 132, Height: 40}}
	root.Init()
	root.View()
	b.ReportAllocs()

	for b.Loop() {
		if root.View().Content == "" {
			b.Fatal("empty dashboard")
		}
	}
}
