package tui

import (
	"fmt"
	"reflect"

	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"google.golang.org/protobuf/proto"
)

// Each fixed dashboard scope retains one input and one result, never a history.
// Clone protobuf inputs: callers may reuse and mutate a snapshot without advancing
// its sequence. Pointer identity and event cursors cannot establish visual equality.
type renderInput struct {
	key      string
	text     string
	theme    theme.Theme
	messages []proto.Message
}
type renderMemo struct {
	input    renderInput
	revision uint64
	value    string
}

func (m *Model) memo(scope string) *renderMemo {
	if m.retained == nil {
		m.retained = make(map[string]*renderMemo)
	}

	if m.retained[scope] == nil {
		m.retained[scope] = &renderMemo{}
	}

	return m.retained[scope]
}

func (c *renderMemo) update(input renderInput) uint64 {
	equal := c.revision != 0 && c.input.key == input.key && c.input.text == input.text && reflect.DeepEqual(c.input.theme, input.theme) && len(c.input.messages) == len(input.messages)
	if equal {
		for i, message := range input.messages {
			if !proto.Equal(c.input.messages[i], message) {
				equal = false
				break
			}
		}
	}

	if !equal {
		c.revision++

		c.input = renderInput{key: input.key, text: input.text, theme: input.theme, messages: make([]proto.Message, len(input.messages))}
		for i, message := range input.messages {
			c.input.messages[i] = proto.Clone(message)
		}
	}

	return c.revision
}

func (c *renderMemo) render(input renderInput, render func() string) string {
	previous := c.revision
	if c.update(input) != previous {
		c.value = render()
	}

	return c.value
}

func (m *Model) input(key string, messages ...proto.Message) renderInput {
	return renderInput{key: key, theme: m.theme, messages: messages}
}

func (m *Model) subjectSnapshot() *v1.Snapshot {
	jobs := make([]*v1.Job, 0, len(m.snapshot.GetJobs()))
	for _, job := range m.snapshot.GetJobs() {
		jobs = append(jobs, &v1.Job{Id: job.GetId(), Task: job.GetTask()})
	}

	return &v1.Snapshot{Jobs: jobs, Tracking: m.snapshot.GetTracking(), MergeStatuses: m.snapshot.GetMergeStatuses()}
}

func (m *Model) regionInput(id string) renderInput {
	key := fmt.Sprintf("%d/%t/%q/%q", m.panel, m.expanded, m.focus.Current(), m.selected)

	switch id {
	case "header":
		subject := m.currentSubject()
		return m.input(fmt.Sprintf("%d/%q/%q/%q/%t", m.panel, subject.label, subject.url, m.connectionError, m.snapshot != nil))
	case "navigation":
		return m.input(fmt.Sprint(m.panel))
	case "context":
		switch m.panel {
		case reviewsPanel, trackingPanel:
			pr := m.currentSubject().tracked
			return m.input(key, pr, m.mergeStatus(pr.GetId()))
		case outputPanel, statePanel:
			return m.input(key, &v1.Snapshot{Scheduler: m.snapshot.GetScheduler(), Worker: m.snapshot.GetWorker()})
		case githubPanel:
			return m.input(key, m.snapshot.GetGithubUsage())
		case activityPanel:
			return m.input(key)
		default:
			return m.input(key)
		}
	case "pull-requests":
		return m.input(m.selected, m.subjectSnapshot())
	case "worker":
		return m.input(fmt.Sprintf("%s/%d/%d", key, m.activity.YOffset(), m.memo("worker-content").revision), m.job(), &v1.Snapshot{Worker: m.snapshot.GetWorker(), RecoveryPid: new(m.snapshot.GetRecoveryPid()), Jobs: m.subjectSnapshot().GetJobs()})
	case "footer":
		return m.input(fmt.Sprintf("%s/%d", key, m.snapshot.GetScheduler()))
	case "notice":
		return m.input(fmt.Sprintf("%s/%q/%q/%s", key, m.connectionError, m.commandError, m.screen.Plan().Variant()))
	default:
		input := m.input(fmt.Sprintf("%s/%d/%d/%d", key, m.result.YOffset(), m.result.Height(), m.result.TotalLineCount()))
		input.text = m.resultContent

		return input
	}
}

func (m *Model) contentInput(width int) renderInput {
	key := fmt.Sprintf("%d/%q/%q", m.panel, m.selected, m.instance)
	switch m.panel {
	case reviewsPanel:
		address := m.currentSubject().url
		return m.input(fmt.Sprintf("%s/%q/%t/%q", key, address, m.reviewLoading[address], m.reviewErrors[address]), m.reviews[address], m.reviewStatuses[address])
	case outputPanel:
		return m.input(key, m.job(), &v1.Snapshot{RecentEvents: m.events()})
	case statePanel:
		return m.input(fmt.Sprintf("%s/%d/%q/%q/%t/%v", key, width, m.history.job, m.history.instance, m.history.loading, m.history.err), m.job(), &v1.Snapshot{RecentEvents: m.history.events, AllowedTransitions: m.snapshot.GetAllowedTransitions(), Scheduler: m.snapshot.GetScheduler(), Worker: m.snapshot.GetWorker(), Jobs: m.subjectSnapshot().GetJobs()})
	case trackingPanel:
		return m.input(fmt.Sprintf("%s/%d", key, width), m.subjectSnapshot(), &v1.Snapshot{Repairs: m.snapshot.GetRepairs()}, m.selectedRefresh)
	case githubPanel:
		return m.input(fmt.Sprintf("%s/%d/%d", key, width, m.githubHours), m.snapshot.GetGithubUsage(), m.schedulerViewStatus())
	case activityPanel:
		// Activity owns its bounded-page cache; do not clone its loaded history here.
		return m.input(key)
	default:
		return m.input(key)
	}
}

// PresentationRevision lets Charmed suppress frames for reconnect ticks and
// repeated observations. Native scrolling, focus, chrome errors and palette
// changes participate just like coordinator data. Runtime owns the frame timer.
func (m *Model) PresentationRevision() uint64 {
	screen, err := m.dashboardScreen()
	if err != nil {
		m.presentationRevision++
		return m.presentationRevision
	}

	memo := m.memo("presentation-layout")
	previous := memo.revision

	changed := memo.update(m.input(fmt.Sprintf("%d/%t/%d/%d", m.panel, m.expanded, m.size.Width, m.size.Height))) != previous
	for _, region := range screen.Plan().Regions() {
		memo = m.memo("region:" + region.ID)

		previous = memo.revision
		if memo.update(m.regionInput(region.ID)) != previous {
			changed = true
		}
	}

	if changed {
		m.presentationRevision++
	}

	return m.presentationRevision
}

// The display consumes cadence and dispatch state, not the tick's identity.
func (m *Model) schedulerViewStatus() *v1.GitHubSchedulerStatus {
	status := m.snapshot.GetGithubScheduler()
	if status == nil {
		return nil
	}

	visible := &v1.GitHubSchedulerStatus{TickMs: status.GetTickMs(), RequestSpacingMs: status.GetRequestSpacingMs(), QueuedRequests: status.GetQueuedRequests(), InFlight: status.GetInFlight(), CoreRetryAtMs: status.GetCoreRetryAtMs(), GraphqlRetryAtMs: status.GetGraphqlRetryAtMs()}
	if status.GetInFlight() || status.GetQueuedRequests() > 0 {
		visible.NextDispatchAtMs = status.GetNextDispatchAtMs()
	}

	return visible
}
