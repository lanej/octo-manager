package client_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"github.com/lanej/octo-manager/internal/client"
)

func TestGeneratedGoClientTalksToBunOverUnixSocket(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	//nolint:usetesting // WHY: Short temporary paths keep the Unix socket within macOS path limits.
	directory, err := os.MkdirTemp("", "om-")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		if removeErr := os.RemoveAll(directory); removeErr != nil {
			t.Error(removeErr)
		}
	})

	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}

	//nolint:gosec // WHY: The executable and fixture are fixed; the only variable argument is test-owned state.
	command := exec.CommandContext(ctx, "bun", "test/rpc-server.mjs", directory)
	command.Dir = root
	command.Stderr = os.Stderr

	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}

	if err = command.Start(); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		if signalErr := command.Process.Signal(os.Interrupt); signalErr != nil && !errors.Is(signalErr, os.ErrProcessDone) {
			t.Error(signalErr)
		}

		if waitErr := command.Wait(); waitErr != nil {
			t.Error(waitErr)
		}
	})

	var ready struct {
		Ready bool `json:"ready"`
	}
	if err = json.NewDecoder(stdout).Decode(&ready); err != nil || !ready.Ready {
		t.Fatalf("server readiness: %v", err)
	}

	api := client.New(filepath.Join(directory, "run.sock"))
	t.Cleanup(api.Close)

	initial, err := api.RPC.GetSnapshot(ctx, connect.NewRequest(&v1.GetSnapshotRequest{}))
	if err != nil {
		t.Fatal(err)
	}

	request := &v1.SubmitJobRequest{RequestId: "go-contract", Task: &v1.Task{Kind: &v1.Task_ResolveConflict{ResolveConflict: &v1.ResolveConflictTask{}}}}

	accepted, err := api.RPC.SubmitJob(ctx, connect.NewRequest(request))
	if err != nil {
		t.Fatal(err)
	}

	duplicate, err := api.RPC.SubmitJob(ctx, connect.NewRequest(request))
	if err != nil || duplicate.Msg.GetJob().GetId() != accepted.Msg.GetJob().GetId() {
		t.Fatalf("idempotent submit: %v", err)
	}

	stream, err := api.RPC.Watch(ctx, connect.NewRequest(&v1.WatchRequest{InstanceId: initial.Msg.GetSnapshot().GetInstanceId(), AfterSequence: initial.Msg.GetSnapshot().GetSequence()}))
	if err != nil {
		t.Fatal(err)
	}

	if !stream.Receive() {
		t.Fatalf("stream failed: %v", stream.Err())
	}

	observed := stream.Msg().GetEvent()
	if observed.GetJobId() != accepted.Msg.GetJob().GetId() || observed.GetKind() != "queued" {
		t.Fatalf("missed cursor event: %v", observed)
	}

	if err = stream.Close(); err != nil {
		t.Fatal(err)
	}

	pending, err := api.RPC.GetJob(ctx, connect.NewRequest(&v1.GetJobRequest{Id: accepted.Msg.GetJob().GetId()}))
	if err != nil || pending.Msg.GetJob().GetStatus() != v1.JobStatus_JOB_STATUS_QUEUED {
		t.Fatalf("stream cancellation changed job: %v", err)
	}

	if _, err = api.RPC.SetPaused(ctx, connect.NewRequest(&v1.SetPausedRequest{Paused: false})); err != nil {
		t.Fatal(err)
	}

	for {
		result, getErr := api.RPC.GetJob(ctx, connect.NewRequest(&v1.GetJobRequest{Id: accepted.Msg.GetJob().GetId()}))
		if getErr != nil {
			t.Fatal(getErr)
		}

		if result.Msg.GetJob().GetStatus() == v1.JobStatus_JOB_STATUS_SUCCEEDED {
			break
		}

		if result.Msg.GetJob().GetStatus() == v1.JobStatus_JOB_STATUS_FAILED {
			t.Fatal(result.Msg.GetJob().GetError())
		}

		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
}
