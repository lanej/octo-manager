package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func TestDisplayTimeDefaultsAndDST(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"", "local"} {
		location, err := DisplayLocation(name)
		if err != nil || location != time.Local {
			t.Fatalf("default display zone: %v %v", location, err)
		}
	}

	if _, err := DisplayLocation("Not/A_Timezone"); err == nil {
		t.Fatal("invalid display timezone was accepted")
	}

	cases := []struct{ zone, instant, want string }{
		{"America/Los_Angeles", "2026-03-08T09:59:00Z", "2026-03-08 01:59:00 PST -0800"},
		{"America/Los_Angeles", "2026-03-08T10:01:00Z", "2026-03-08 03:01:00 PDT -0700"},
		{"America/Los_Angeles", "2026-11-01T08:30:00Z", "2026-11-01 01:30:00 PDT -0700"},
		{"America/Los_Angeles", "2026-11-01T09:30:00Z", "2026-11-01 01:30:00 PST -0800"},
		{"America/Los_Angeles", "2026-11-11T01:30:00Z", "2026-11-10 17:30:00 PST -0800"},
		{"Asia/Kathmandu", "2026-11-11T01:30:00Z", "2026-11-11 07:15:00 +0545"},
		{"UTC", "2026-11-11T01:30:00Z", "2026-11-11 01:30:00 UTC +0000"},
	}
	for _, c := range cases {
		t.Run(c.zone+"/"+c.instant, func(t *testing.T) {
			t.Parallel()

			location, err := DisplayLocation(c.zone)
			if err != nil {
				t.Fatal(err)
			}

			instant, err := time.Parse(time.RFC3339, c.instant)
			if err != nil {
				t.Fatal(err)
			}

			m := model(t, theme.Dark)

			m.location = location
			if got := m.timestamp(instant.UnixMilli(), fullTimestamp); got != c.want {
				t.Fatalf("timestamp=%q,want %q", got, c.want)
			}
		})
	}
}

func TestAllDashboardTimesUseTheDisplayZone(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)

	location, err := DisplayLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}

	m.location = location
	instant := time.Date(2026, 11, 11, 1, 30, 0, 0, time.UTC).UnixMilli()
	pr := &v1.TrackedPullRequest{Id: "pr", Url: "https://github.com/owner/repo/pull/42", Observation: &v1.TrackingObservation{ObservedAtMs: instant}}
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{pr}}
	m.snapshot.Repairs = []*v1.RepairAttempt{{PrId: "pr", UpdatedAtMs: instant}}
	job := prJob("run", pr.GetUrl())
	m.snapshot.Jobs = []*v1.Job{job}
	m.selected = job.GetId()
	job.Attempts = []*v1.Attempt{{ExitObservedAtMs: new(instant)}}
	m.history = historyState{job: m.selected, instance: m.instance, events: []*v1.JobEvent{{AtMs: instant, Kind: "queued", Sequence: 1}, {AtMs: instant, Kind: "tool", Detail: "read file", Sequence: 2}}}
	address := m.currentSubject().url
	m.reviews[address] = &v1.PullRequestDetails{ObservedAtMs: instant, Messages: []*v1.ReviewMessage{{AtMs: instant}}}

	views := []string{m.trackingContent(), m.activityTime(instant), m.repairContent("pr"), m.reviewsMarkdown(), m.stateView(100), strings.Join(m.workerLines(), "\n"), m.deliveryDetails("{\"NextAttemptAt\":" + fmt.Sprint(instant) + "}")}
	for _, view := range views {
		if !strings.Contains(ansi.Strip(view), "17:30") || !strings.Contains(ansi.Strip(view), "PST -0800") {
			t.Errorf("view did not use display zone: %s", ansi.Strip(view))
		}
	}

	m.Resize(layout.Size{Width: 132, Height: 40})

	if !strings.Contains(ansi.Strip(m.activity.View()), "17:30:00") || !strings.Contains(ansi.Strip(m.activity.View()), "PST -0800") {
		t.Fatal("recent tools did not use the display timezone")
	}

	if pr.GetObservation().GetObservedAtMs() != instant || job.GetAttempts()[0].GetExitObservedAtMs() != instant {
		t.Fatal("presentation changed source timestamps")
	}
}
