package client_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	api "github.com/lanej/octo-manager/gen/octomanager/v2"
	"github.com/lanej/octo-manager/gen/octomanager/v2/octomanagerv2connect"
	"github.com/lanej/octo-manager/internal/client"
)

type incompatibleServer struct {
	octomanagerv2connect.UnimplementedSchedulerServiceHandler
}

func (incompatibleServer) GetServerInfo(context.Context, *connect.Request[api.GetServerInfoRequest]) (*connect.Response[api.GetServerInfoResponse], error) {
	return connect.NewResponse(&api.GetServerInfoResponse{ApiVersion: 1}), nil
}

func TestDashboardStreamRejectsAnIncompatibleServer(t *testing.T) {
	t.Parallel()
	//nolint:usetesting // WHY: Short paths keep the Unix socket within macOS path limits.
	directory, err := os.MkdirTemp("", "om-version-")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		if removeErr := os.RemoveAll(directory); removeErr != nil {
			t.Error(removeErr)
		}
	})

	socket := filepath.Join(directory, "run.sock")

	listenConfig := net.ListenConfig{}

	listener, err := listenConfig.Listen(t.Context(), "unix", socket)
	if err != nil {
		t.Fatal(err)
	}

	_, handler := octomanagerv2connect.NewSchedulerServiceHandler(incompatibleServer{})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 1000000000}

	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()

	t.Cleanup(func() {
		if closeErr := server.Close(); closeErr != nil {
			t.Error(closeErr)
		}

		if serveErr := <-done; serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			t.Error(serveErr)
		}
	})

	connection := client.New(socket)
	defer connection.Close()

	_, err = connection.RPC.WatchDashboard(t.Context(), connect.NewRequest(&api.WatchDashboardRequest{Url: "https://github.com/o/r/pull/1"}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "update the server, CLI, and dashboard together") {
		t.Fatalf("unexpected incompatible-stream result: %v", err)
	}
}
