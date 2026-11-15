package client

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"connectrpc.com/connect"
	api "github.com/lanej/octo-manager/gen/octomanager/v2"
	"github.com/lanej/octo-manager/gen/octomanager/v2/octomanagerv2connect"
)

type versionInterceptor struct {
	raw     octomanagerv2connect.SchedulerServiceClient
	mutex   sync.Mutex
	checked bool
}

func incompatibleAPI() error {
	return connect.NewError(connect.CodeFailedPrecondition, errors.New("incompatible Octo API; update the server, CLI, and dashboard together"))
}

func (v *versionInterceptor) ensure(ctx context.Context) error {
	v.mutex.Lock()
	defer v.mutex.Unlock()

	if v.checked {
		return nil
	}

	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	info, err := v.raw.GetServerInfo(deadline, connect.NewRequest(&api.GetServerInfoRequest{}))
	if err != nil {
		if connect.CodeOf(err) == connect.CodeUnimplemented || connect.CodeOf(err) == connect.CodeNotFound {
			return incompatibleAPI()
		}

		return err
	}

	if info.Msg.GetApiVersion() != 2 {
		return incompatibleAPI()
	}

	v.checked = true

	return nil
}

func (v *versionInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if request.Spec().Procedure != octomanagerv2connect.SchedulerServiceGetServerInfoProcedure {
			if err := v.ensure(ctx); err != nil {
				return nil, err
			}
		}

		return next(ctx, request)
	}
}

func (v *versionInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		if err := v.ensure(ctx); err != nil {
			return &failedStream{spec: spec, err: err}
		}

		return next(ctx, spec)
	}
}

func (v *versionInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

// failedStream rejects a stream before the transport is opened.
type failedStream struct {
	spec connect.Spec
	err  error
}

func (s *failedStream) Spec() connect.Spec           { return s.spec }
func (s *failedStream) Peer() connect.Peer           { return connect.Peer{} }
func (s *failedStream) Send(any) error               { return s.err }
func (s *failedStream) Receive(any) error            { return s.err }
func (s *failedStream) RequestHeader() http.Header   { return http.Header{} }
func (s *failedStream) ResponseHeader() http.Header  { return http.Header{} }
func (s *failedStream) ResponseTrailer() http.Header { return http.Header{} }
func (s *failedStream) CloseRequest() error          { return nil }
func (s *failedStream) CloseResponse() error         { return nil }
