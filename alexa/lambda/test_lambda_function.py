"""Tests fuer alexa/lambda/lambda_function.py.

ask-sdk und requests sind NICHT installiert: alle SDK-Objekte werden an
klaren Grenzen per Stub-Module ersetzt (sys.modules-Injektion vor dem
Import). Keine echten Netzwerke, kein AWS, kein Gateway: requests.post
wird pro Test gepatcht.
"""

import os
import sys
import time
import types
import unittest
from unittest import mock
from xml.sax.saxutils import escape

# ---- Stub-Module fuer ask-sdk / requests (vor dem Import injizieren) ----


def _stub_module(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules.setdefault(name, mod)
    return mod


def install_stubs():
    import importlib

    # ask_utils: is_request_type/is_intent_name liefern Match-Funktionen
    ask_utils = _stub_module("ask_sdk_core.utils")
    ask_utils.is_request_type = lambda t: (lambda hi: getattr(getattr(hi, "request_envelope", None).request, "__type__", "") == t)
    ask_utils.is_intent_name = lambda n: (lambda hi: getattr(getattr(getattr(hi, "request_envelope", None).request, "intent", None), "name", "") == n)

    class CustomSkillBuilder:
        def __init__(self, api_client=None):
            self.handlers = []
            self.skill_id = None

        def add_request_handler(self, h):
            self.handlers.append(h)
            return h

        def add_exception_handler(self, h):
            self.handlers.append(h)
            return h

        def lambda_handler(self):
            # bildet den eingebauten Skill-ID-Verifier des ask-sdk nach
            # (CustomSkill.invoke): gesetzte skill_id -> applicationId muss passen
            def handler(event, context):
                if self.skill_id is not None:
                    app_id = (
                        ((event.get("context") or {}).get("System") or {})
                        .get("application", {})
                        .get("applicationId")
                    )
                    if app_id != self.skill_id:
                        raise RuntimeError("Skill ID Verification failed!!")
                return {"stub": True}

            return handler

    core = _stub_module("ask_sdk_core")
    _stub_module("ask_sdk_core.skill_builder", CustomSkillBuilder=CustomSkillBuilder)
    _stub_module("ask_sdk_core.api_client", DefaultApiClient=type("DefaultApiClient", (), {}))
    _stub_module(
        "ask_sdk_core.dispatch_components",
        AbstractRequestHandler=type("AbstractRequestHandler", (), {}),
        AbstractExceptionHandler=type("AbstractExceptionHandler", (), {}),
    )
    directive = _stub_module(
        "ask_sdk_model.services.directive",
        SendDirectiveRequest=lambda **kw: kw,
        Header=lambda **kw: kw,
        SpeakDirective=lambda **kw: kw,
    )
    _stub_module("ask_sdk_model", __path__=[])
    _stub_module("ask_sdk_model.ui", SimpleCard=lambda **kw: kw)
    _stub_module(
        "ask_sdk_model.interfaces",
        __path__=[],
    )
    _stub_module("ask_sdk_model.interfaces.alexa", __path__=[])
    _stub_module(
        "ask_sdk_model.interfaces.alexa.presentation",
        __path__=[],
    )
    _stub_module(
        "ask_sdk_model.interfaces.alexa.presentation.apl",
        ExecuteCommandsDirective=lambda **kw: kw,
        RenderDocumentDirective=lambda **kw: kw,
    )
    if "requests" not in sys.modules:
        _stub_module("requests", post=lambda *a, **kw: None)
    importlib.invalidate_caches()


install_stubs()

# Env vor dem Import setzen (Modul liest beim Laden)
os.environ.setdefault("gateway_url", "https://gw.example.org")
os.environ.setdefault("api_token", "test-token")
os.environ.setdefault("watchdog_delay", "0.1")
os.environ.setdefault("gateway_timeout", "0.4")
os.environ.setdefault("warteton_enabled", "true")
os.environ.setdefault("acknowledgment_enabled", "false")
os.environ.setdefault("alexa_skill_id", "amzn1.ask.skill.test")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lambda_function  # noqa: E402


class FakeResponseBuilder:
    def __init__(self):
        self.calls = []
        self.response = {"builder": "done"}

    def speak(self, s):
        self.calls.append(("speak", s))
        return self

    def set_card(self, card):
        self.calls.append(("card", card))
        return self

    def ask(self, s):
        self.calls.append(("ask", s))
        return self

    def set_should_end_session(self, b):
        self.calls.append(("end", b))
        return self

    def add_directive(self, d):
        self.calls.append(("directive", d))
        return self


class FakeDirectiveService:
    def __init__(self):
        self.enqueued = []

    def enqueue(self, req):
        self.enqueued.append(req)


class FakeRequest:
    def __init__(self, request_id="req-1", locale=None):
        self.request_id = request_id
        self.locale = locale


class FakeIntent:
    def __init__(self, slots=None, name="GptQueryIntent"):
        self.slots = slots or {}
        self.name = name


class FakeSystem:
    def __init__(self):
        self.device = None


class FakeContext:
    def __init__(self):
        self.system = FakeSystem()


class FakeEnvelope:
    def __init__(self, request=None, session=None):
        self.request = request
        self.session = session
        self.context = FakeContext()


class FakeSession:
    def __init__(self, session_id="amzn1.session.test"):
        self.session_id = session_id
        self.user = types.SimpleNamespace(user_id="amzn1.user.test")


class FakeHandlerInput:
    def __init__(self, request=None, session=None, event=None):
        self.request_envelope = FakeEnvelope(request, session)
        self.response_builder = FakeResponseBuilder()
        self.service_client_factory = types.SimpleNamespace(
            get_directive_service=lambda: self.directive_service
        )
        self.directive_service = FakeDirectiveService()


def fake_response(payload):
    resp = mock.MagicMock()
    resp.status_code = 200
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    return resp


class StripSsmlTest(unittest.TestCase):
    def test_entfernt_speak_break_und_tags(self):
        self.assertEqual(
            lambda_function.strip_ssml("<speak>Hallo <break time='300ms'/>Welt<b>!</b></speak>"),
            "Hallo Welt!",
        )

    def test_kollabiert_leerzeichen(self):
        self.assertEqual(lambda_function.strip_ssml("a   b\tc"), "a b c")

    def test_klartext_bleibt_unveraendert(self):
        self.assertEqual(lambda_function.strip_ssml("nur text"), "nur text")


class LocaleStringsTest(unittest.TestCase):
    def test_welcome_enthaelt_assistentennamen(self):
        hi = FakeHandlerInput(request=FakeRequest())
        self.assertIn(lambda_function.assistant_name, lambda_function.t(hi, "welcome"))

    def test_unbekannte_locale_faellt_auf_de_de(self):
        hi = FakeHandlerInput(request=FakeRequest(locale="en-US"))
        self.assertEqual(lambda_function.t(hi, "error"), lambda_function.SPEAK_ERROR)

    def test_fehlende_locale_faellt_auf_de_de(self):
        hi = FakeHandlerInput(request=FakeRequest(locale=None))
        self.assertEqual(lambda_function.t(hi, "help"), lambda_function.STRINGS["de-DE"]["help"])

    def test_stop_kommt_aus_der_de_liste(self):
        hi = FakeHandlerInput(request=FakeRequest(locale="de-DE"))
        self.assertIn(lambda_function.t(hi, "stop"), lambda_function.STRINGS["de-DE"]["stop"])


class CallGatewayTest(unittest.TestCase):
    def test_bearer_header_url_und_payload(self):
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "hallo", "followUp": False})
            speech, follow_up, is_ssml, display, followup = lambda_function.call_gateway(
                "frage", "sess-1", "user-1"
            )
        args, kwargs = req.post.call_args
        self.assertEqual(args[0], "https://gw.example.org/api/query")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-token")
        self.assertEqual(kwargs["json"], {"sessionId": "sess-1", "text": "frage", "userId": "user-1"})
        self.assertEqual(speech, "hallo")
        self.assertFalse(follow_up)

    def test_envelope_mit_response_wird_entpackt(self):
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response(
                {"response": {"speech": "<speak>hi</speak>", "ssml": True, "followUp": True}}
            )
            speech, follow_up, is_ssml, _, _ = lambda_function.call_gateway("q", "s", None)
        self.assertEqual(speech, "<speak>hi</speak>")
        self.assertTrue(follow_up)
        self.assertTrue(is_ssml)

    def test_speak_erkennung_aus_prefix(self):
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "<speak>x"})
            _, _, is_ssml, _, _ = lambda_function.call_gateway("q", "s", None)
        self.assertTrue(is_ssml)

    def test_leeres_followupprompt_wird_none(self):
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "x", "followUp": True, "followupPrompt": "   "})
            _, _, _, _, followup = lambda_function.call_gateway("q", "s", None)
        self.assertIsNone(followup)

    def test_display_text_wird_übernommen(self):
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response(
                {"speech": "a", "display": {"text": " Anzeige "}}
            )
            _, _, _, display, _ = lambda_function.call_gateway("q", "s", None)
        self.assertEqual(display, "Anzeige")

    def test_http_fehler_wirft(self):
        with mock.patch.object(lambda_function, "requests") as req:
            resp = mock.MagicMock()
            resp.raise_for_status.side_effect = RuntimeError("HTTP 500")
            req.post.return_value = resp
            with self.assertRaises(RuntimeError):
                lambda_function.call_gateway("q", "s", None)

    def test_ohne_gateway_url_wirft(self):
        with mock.patch.object(lambda_function, "gateway_url", ""), self.assertRaises(RuntimeError):
            lambda_function.call_gateway("q", "s", None)


class GptQueryIntentTest(unittest.TestCase):
    def _handler_input(self, apl=False):
        hi = FakeHandlerInput(
            request=FakeRequest(),
            session=FakeSession(),
        )
        hi.request_envelope.request.intent = FakeIntent(slots={"query": types.SimpleNamespace(value="wetter")})
        if apl:
            lambda_function._RAW_ENVELOPE.value = {
                "context": {"System": {"device": {"supportedInterfaces": {"ALEXA_PRESENTATION_APL": {}}}}}
            }
        else:
            lambda_function._RAW_ENVELOPE.value = {}
        return hi

    def test_klartext_wird_escaped_und_session_endet(self):
        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "Antwort <mit> & Zeichen", "followUp": False})
            r = lambda_function.GptQueryIntentHandler().handle(hi)
        calls = hi.response_builder.calls
        speak = [c for c in calls if c[0] == "speak"][0][1]
        self.assertEqual(speak, escape("Antwort <mit> & Zeichen"))
        end = [c for c in calls if c[0] == "end"][0][1]
        self.assertTrue(end)
        self.assertEqual(hi.directive_service.enqueued, [], "kein Warteton ohne Watchdog")

    def test_ssml_wird_roh_durchgereicht(self):
        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "<speak>ssml</speak>", "ssml": True})
            lambda_function.GptQueryIntentHandler().handle(hi)
        speak = [c for c in hi.response_builder.calls if c[0] == "speak"][0][1]
        self.assertEqual(speak, "<speak>ssml</speak>")

    def test_followup_fragt_nach(self):
        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response(
                {"speech": "a", "followUp": True, "followupPrompt": "Was noch?"}
            )
            lambda_function.GptQueryIntentHandler().handle(hi)
        asks = [c[1] for c in hi.response_builder.calls if c[0] == "ask"]
        self.assertEqual(asks, ["Was noch?"])

    def test_apl_dokument_wird_gerendert(self):
        hi = self._handler_input(apl=True)
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "a", "followUp": False})
            lambda_function.GptQueryIntentHandler().handle(hi)
        directives = [c[1] for c in hi.response_builder.calls if c[0] == "directive"]
        self.assertTrue(any(d.get("token", "").startswith("mainhelfer-display") for d in directives))

    def test_watchdog_sendet_warteton_und_laesst_session_offen(self):
        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req:
            def slow(*a, **kw):
                time.sleep(1.0)  # laenger als watchdog_delay + gateway_timeout
                return fake_response({"speech": "spaet"})

            req.post.side_effect = slow
            r = lambda_function.GptQueryIntentHandler().handle(hi)
        speak = [c for c in hi.response_builder.calls if c[0] == "speak"][0][1]
        self.assertEqual(speak, lambda_function.STRINGS["de-DE"]["error_timeout"])
        end = [c for c in hi.response_builder.calls if c[0] == "end"][0][1]
        self.assertFalse(end, "Session bleibt offen")
        self.assertEqual(len(hi.directive_service.enqueued), 1, "Warteton nach Watchdog")
        # auf Worker-Thread warten, damit der Test nicht auf den Daemon wartet
        time.sleep(0.1)

    def test_gateway_fehler_spricht_unerreichbar(self):
        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.side_effect = RuntimeError("kaputt")
            r = lambda_function.GptQueryIntentHandler().handle(hi)
        speak = [c for c in hi.response_builder.calls if c[0] == "speak"][0][1]
        self.assertEqual(speak, lambda_function.STRINGS["de-DE"]["error_unreachable"])

    def test_gateway_timeout_exception_spricht_timeout(self):
        class ReadTimeout(Exception):
            pass

        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.side_effect = ReadTimeout("zu spaet")
            lambda_function.GptQueryIntentHandler().handle(hi)
        speak = [c for c in hi.response_builder.calls if c[0] == "speak"][0][1]
        self.assertEqual(speak, lambda_function.STRINGS["de-DE"]["error_timeout"])

    def test_send_progressive_ohne_request_id_ohne_call(self):
        hi = FakeHandlerInput(request=FakeRequest(request_id=None), session=FakeSession())
        lambda_function.send_progressive(hi, hi.request_envelope.request, "wartet")
        self.assertEqual(hi.directive_service.enqueued, [])

    def test_send_progressive_enqueue(self):
        hi = FakeHandlerInput(request=FakeRequest("rid-9"), session=FakeSession())
        lambda_function.send_progressive(hi, hi.request_envelope.request, "wartet kurz")
        self.assertEqual(len(hi.directive_service.enqueued), 1)
        req = hi.directive_service.enqueued[0]
        self.assertEqual(req["directive"]["speech"], "wartet kurz")


class SupportsAplTest(unittest.TestCase):
    def test_roh_event_ohne_apl_false(self):
        lambda_function._RAW_ENVELOPE.value = {"context": {"System": {"device": {"supportedInterfaces": {}}}}}
        hi = FakeHandlerInput()
        self.assertFalse(lambda_function.supports_apl(hi))

    def test_roh_event_mit_apl_true(self):
        lambda_function._RAW_ENVELOPE.value = {
            "context": {"System": {"device": {"supportedInterfaces": {"ALEXA_PRESENTATION_APL": {}}}}}
        }
        hi = FakeHandlerInput()
        self.assertTrue(lambda_function.supports_apl(hi))

    def test_leeres_event_false(self):
        lambda_function._RAW_ENVELOPE.value = {}
        hi = FakeHandlerInput()
        self.assertFalse(lambda_function.supports_apl(hi))


class SkillIdVerificationTest(unittest.TestCase):
    def _event(self, app_id):
        return {
            "context": {"System": {"application": {"applicationId": app_id}}},
            "request": {"type": "LaunchRequest"},
        }

    def test_skill_id_wird_aus_env_konfiguriert(self):
        self.assertEqual(lambda_function.sb.skill_id, "amzn1.ask.skill.test")

    def test_passende_application_id_wird_akzeptiert(self):
        result = lambda_function.lambda_handler(
            self._event("amzn1.ask.skill.test"), None
        )
        self.assertEqual(result, {"stub": True})

    def test_abweichende_application_id_wird_abgelehnt(self):
        with self.assertRaises(RuntimeError):
            lambda_function.lambda_handler(
                self._event("amzn1.ask.skill.fremd"), None
            )


class AuditFindingsTest(unittest.TestCase):
    """Audit-Proben (Voll-Audit 2026-09-27): Regressionstests fuer F-23..F-25."""

    def _handler_input(self):
        hi = FakeHandlerInput(request=FakeRequest(), session=FakeSession())
        hi.request_envelope.request.intent = FakeIntent(
            slots={"query": types.SimpleNamespace(value="meine geheime frage")}
        )
        lambda_function._RAW_ENVELOPE.value = {}
        return hi

    def test_nutzerfrage_wird_nicht_geloggt(self):
        """F-23: lambda_function.py loggt die Nutzerfrage im Klartext."""
        hi = self._handler_input()
        with mock.patch.object(lambda_function, "requests") as req, \
                mock.patch.object(lambda_function.logger, "info") as log_info:
            req.post.return_value = fake_response({"speech": "ok", "followUp": False})
            lambda_function.GptQueryIntentHandler().handle(hi)
        protokoll = " ".join(str(c) for c in log_info.call_args_list)
        self.assertNotIn("meine geheime frage", protokoll)

    def test_fehlender_query_slot_fuehrt_nicht_zum_crash(self):
        """F-24: fehlt der Pflicht-Slot query, wirft der Handler KeyError."""
        hi = FakeHandlerInput(request=FakeRequest(), session=FakeSession())
        hi.request_envelope.request.intent = FakeIntent(slots={})
        lambda_function._RAW_ENVELOPE.value = {}
        with mock.patch.object(lambda_function, "requests") as req:
            req.post.return_value = fake_response({"speech": "ok"})
            lambda_function.GptQueryIntentHandler().handle(hi)  # darf nicht werfen

    def test_strip_ssml_dekodiert_entities(self):
        """F-25: strip_ssml dekodiert XML-Entities nicht (Anzeige zeigt '&amp;')."""
        self.assertEqual(
            lambda_function.strip_ssml("<speak>Milch &amp; Honig</speak>"),
            "Milch & Honig",
        )


if __name__ == "__main__":
    unittest.main()
