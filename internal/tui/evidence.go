package tui

import (
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// variantPayload reads the selected, schema-defined alternative without reparsing data.
func variantPayload(value proto.Message) protoreflect.Message {
	if value == nil {
		return nil
	}

	message := value.ProtoReflect()
	if !message.IsValid() {
		return nil
	}

	alternative := message.Descriptor().Oneofs().ByName("variant")
	if alternative == nil {
		return nil
	}

	field := message.WhichOneof(alternative)
	if field == nil {
		return nil
	}

	return message.Get(field).Message()
}

func observationStatus(value proto.Message) string {
	message := variantPayload(value)
	if message == nil {
		return "unavailable"
	}

	field := message.Descriptor().Fields().ByName("state")
	if field == nil || !message.Has(field) {
		return "unavailable"
	}

	enumeration := field.Enum().Values().ByNumber(message.Get(field).Enum())
	if enumeration == nil {
		return "unavailable"
	}

	name := string(enumeration.Name())
	state := strings.ToLower(name[strings.LastIndex(name, "_")+1:])

	reason := message.Descriptor().Fields().ByName("reason")
	if reason != nil && message.Has(reason) {
		state += " (" + safe(message.Get(reason).String()) + ")"
	}

	return state
}

func (m *Model) deliveryDetails(value proto.Message) string {
	message := variantPayload(value)
	if message == nil {
		return "Delivery details unavailable.\n\n"
	}

	for _, key := range []protoreflect.Name{"reason", "note"} {
		field := message.Descriptor().Fields().ByName(key)
		if field != nil && message.Has(field) {
			return safe(message.Get(field).String()) + "\n\n"
		}
	}

	field := message.Descriptor().Fields().ByName("next_attempt_at")
	if field != nil && message.Has(field) {
		return "Next attempt " + m.timestamp(message.Get(field).Int(), fullTimestamp) + "\n\n"
	}

	return ""
}
