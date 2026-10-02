import html
import json
import logging
import os
import random
import re
import threading
import time
import requests
import ask_sdk_core.utils as ask_utils
from ask_sdk_core.skill_builder import CustomSkillBuilder
from ask_sdk_core.api_client import DefaultApiClient
from ask_sdk_core.dispatch_components import AbstractRequestHandler, AbstractExceptionHandler
from ask_sdk_model.services.directive import SendDirectiveRequest, Header, SpeakDirective
from ask_sdk_model.ui import SimpleCard
from ask_sdk_model.interfaces.alexa.presentation.apl import (
    ExecuteCommandsDirective,
    RenderDocumentDirective,
)

# rohes Request-Event fuer APL-Erkennung (ask-sdk verliert Interface-Keys)
_RAW_ENVELOPE = threading.local()
from xml.sax.saxutils import escape

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if os.environ.get("debug") else logging.INFO)


def load_config():
    """Optionale config.json aus dem Lambda-Verzeichnis (nur im Alexa-Repo,
    wird von der CI erhalten). Env-Variablen haben Vorrang."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return
    for key, value in cfg.items():
        os.environ.setdefault(key, str(value))


load_config()

gateway_url = os.environ.get("gateway_url", "").rstrip("/")
api_token = os.environ.get("api_token", "")
acknowledgment_enabled = os.environ.get("acknowledgment_enabled", "false").lower() == "true"
ask_for_further_commands = os.environ.get("ask_for_further_commands", "false").lower() == "true"
warteton_enabled = os.environ.get("warteton_enabled", "true").lower() == "true"
warteton_phrase = os.environ.get("warteton_phrase", "")
watchdog_delay = float(os.environ.get("watchdog_delay", "6.5"))
gateway_timeout = float(os.environ.get("gateway_timeout", "32"))
alexa_skill_id = os.environ.get("alexa_skill_id", "")
assistant_name = os.environ.get("assistant_name", "Dein SmartPilot")
# Nur Fallback, wenn der Warteton (Progressive Response) aus ist: Alexa erwartet
# dann innerhalb von ~8 s eine Antwort. Mit Warteton darf gateway_timeout bis
# unter das Lambda-Timeout (z. B. 35 s) reichen.
ALEXA_WINDOW = 8.0

# Sprachtexte pro Locale. Aktuell nur de-DE; eine weitere Sprache ist ein
# zusaetzlicher Eintrag hier plus eine Modell-Datei unter
# skill-package/interactionModels/custom/. Der Assistenten-Name kommt aus der
# Umgebung (primaere Locale) und wird als {name} eingesetzt.
DEFAULT_LOCALE = "de-DE"
STRINGS = {
    "de-DE": {
        "welcome": "Hallo, ich bin {name}. Was kann ich für dich tun?",
        "help": "Du kannst mir zum Beispiel nach dem Hausstatus oder aktuellen Informationen fragen.",
        "stop": ["Bis zum nächsten Mal.", "Alles klar, bis später.", "Okay, tschüss."],
        "error": "Entschuldigung, da ist etwas schiefgelaufen.",
        "error_unreachable": "Ich erreiche meinen Server gerade nicht.",
        "error_timeout": "Das dauert zu lange. Frag es gleich nochmal.",
        "processing": "Einen Moment bitte.",
        "warteton": "Einen Moment, ich schaue das kurz nach.",
        "no_query": "Das habe ich akustisch nicht verstanden. Wie lautet deine Frage?",
    },
}


def _locale_of(handler_input):
    """Locale aus dem Request; unbekannte oder fehlende Locale -> de-DE."""
    try:
        loc = handler_input.request_envelope.request.locale
    except AttributeError:
        loc = None
    return loc if loc in STRINGS else DEFAULT_LOCALE


def t(handler_input, key):
    """Lokalisierter Text; {name} wird durch assistant_name ersetzt."""
    value = STRINGS[_locale_of(handler_input)][key]
    if isinstance(value, list):
        value = random.choice(value)
    return value.replace("{name}", assistant_name)


# de-DE-Default fuer Rueckwaerts-Kompatibilitaet (call_gateway/Tests)
SPEAK_ERROR = STRINGS[DEFAULT_LOCALE]["error"]


def strip_ssml(text):
    text = re.sub(r"<speak>|</speak>", "", text, flags=re.I)
    text = re.sub(r"<break[^>]*/?>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    # XML-Entities aufloesen (escape() erzeugt sie); &amp; zuletzt, damit
    # "&amp;lt;" korrekt zu "&lt;" wird.
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


CARD_TITLE = os.environ.get("skill_name", "SmartPilot")

# Nach diesem Delay (ms) ab Dokument-Render beendet sich das APL-Dokument
# selbst (Finish) und Alexa zeigt wieder ihren Standardbildschirm. Umgeht
# das Geraete-Verhalten "Nach Session-Ende zeigt der Echo Show das Dokument
# der VORHERIGEN Session wieder an" und erfuellt den Wunsch, die Anzeige
# ohne "Alexa verlassen" loszuwerden.
APL_EXIT_DELAY_MS = int(os.environ.get("apl_exit_delay_ms", "90000"))

# APL-Layout. Datenbindung nach offiziellem Muster: der Parameter in
# mainTemplate.parameters MUSS dem Datasource-Schluessel entsprechen
# (datasources {"documentData": ...} -> ${documentData.text}).
# WICHTIG: Eine ScrollView ohne height defaultet auf 100dp; daher height
# "100%". Etwas paddingBottom am Text, damit die letzte Zeile nicht am
# Bildschirmrand abgeschnitten bleibt.
APL_DOCUMENT = {
    "type": "APL",
    "version": "1.4",
    "background": "#161C27",
    "mainTemplate": {
        "parameters": ["documentData"],
        "onMount": [{"type": "Finish", "delay": APL_EXIT_DELAY_MS}],
        "items": [
            {
                "type": "Container",
                "width": "100%",
                "height": "100%",
                "paddingTop": 20,
                "paddingLeft": 30,
                "paddingRight": 30,
                "items": [
                    {
                        "type": "Text",
                        "text": "${documentData.title}",
                        "width": "100%",
                        "fontSize": 32,
                        "fontWeight": "bold",
                        "color": "#00CAFF",
                        "paddingBottom": 12,
                    },
                    {
                        "type": "ScrollView",
                        "width": "100%",
                        "height": "100%",
                        "items": [
                            {
                                "type": "Text",
                                "componentId": "bodyText",
                                "text": "${documentData.text}",
                                "width": "100%",
                                "fontSize": 38,
                                "lineHeight": 1.35,
                                "color": "#EEEEEE",
                                "paddingBottom": 60,
                            }
                        ],
                    },
                ],
            }
        ],
    },
}


def supports_apl(handler_input):
    """Erkennt APL-Support zuverlaessig:
    ask-sdk 1.19 deserialisiert supportedInterfaces NICHT korrekt (Das Model
    mappt auf Punkt-Form 'Alexa.Presentation.APL', Alexa sendet aber
    'ALEXA_PRESENTATION_APL' und der Deserializer verwirft den unbekannten Key).
    Daher wird das ROHE Request-Event geprueft, das der lambda_handler-Wrapper
    vor der Deserialisierung zwischengepuffert hat."""
    try:
        device = handler_input.request_envelope.context.system.device
        interfaces = device.supported_interfaces if device else None
        if interfaces and interfaces.alexa_presentation_apl:
            return True
    except AttributeError:
        pass
    event = getattr(_RAW_ENVELOPE, "value", None) or {}
    try:
        system = (event.get("context") or {}).get("System") or {}
        sup = ((system.get("device") or {}).get("supportedInterfaces") or {})
        return "ALEXA_PRESENTATION_APL" in sup
    except Exception:
        return False


def _previous_apl_token(handler_input):
    """Token des noch angezeigten APL-Dokuments einer FRUEHEREN Session
    (context.Alexa.Presentation.APL.token). Nötig, um es beim naechsten
    Request sauber per ExecuteCommands(Finish) zu beenden - sonst zeigt
    der Echo Show nach Session-Ende wieder das alte Dokument an."""
    event = getattr(_RAW_ENVELOPE, "value", None) or {}
    try:
        return ((event.get("context") or {}).get("Alexa.Presentation.APL") or {}).get("token")
    except Exception:
        return None


def render_apl(handler_input, title, text):
    """Rendert den Antworttext in einer manuell scrollbaren APL-Ansicht.
    Ein noch angezeigtes Dokument einer frueheren Session wird vorher per
    Finish beendet, damit der Echo Show beim Session-Ende nicht zum alten
    Text zurueckspringt. Das neue Dokument terminiert sich per onMount
    (Finish + Delay) selbst und gibt den Standardbildschirm frei."""
    prev_token = _previous_apl_token(handler_input)
    if prev_token:
        handler_input.response_builder.add_directive(
            ExecuteCommandsDirective(token=prev_token, commands=[{"type": "Finish"}])
        )
    token = "mainhelfer-display-{}".format(int(time.time() * 1000))
    handler_input.response_builder.add_directive(
        RenderDocumentDirective(
            token=token,
            document=APL_DOCUMENT,
            datasources={
                "documentData": {
                    "title": title,
                    "text": text,
                }
            },
        )
    )


def _application_id():
    """applicationId aus dem rohen Request-Envelope (context.System.application).
    Wird als Header an das Gateway weitergereicht (optionale Pruefung/Log)."""
    env = _RAW_ENVELOPE.value or {}
    app = (((env.get("context") or {}).get("System") or {}).get("application")) or {}
    return app.get("applicationId", "") if isinstance(app, dict) else ""


def _is_timeout(err):
    """requests-Timeout ohne Import der Exception-Klasse (stub-sicher)."""
    return err.__class__.__name__ in ("Timeout", "ReadTimeout", "ConnectTimeout", "ConnectTimeoutError")


def call_gateway(query, session_id, user_id, skill_id=None):
    if not gateway_url:
        raise RuntimeError("gateway_url nicht konfiguriert")
    headers = {
        "Authorization": "Bearer {}".format(api_token),
        "Content-Type": "application/json",
    }
    if skill_id:
        headers["X-Alexa-Skill-Id"] = skill_id
    data = {"sessionId": session_id, "text": query}
    if user_id:
        data["userId"] = user_id
    response = requests.post(
        "{}/api/query".format(gateway_url), headers=headers, json=data, timeout=gateway_timeout
    )
    response.raise_for_status()
    payload = response.json()
    # /api/query liefert EngineResult (route/response/trace) oder nacktes AssistantResponse
    resp = payload.get("response") if isinstance(payload.get("response"), dict) else payload
    speech = resp.get("speech") or SPEAK_ERROR
    follow_up = bool(resp.get("followUp"))
    followup_prompt = (resp.get("followupPrompt") or "").strip() or None
    ssml = bool(resp.get("ssml")) or speech.strip().startswith("<speak")
    display = resp.get("display") or {}
    display_text = (display.get("text") or "").strip() or None
    return speech, follow_up, ssml, display_text, followup_prompt


def send_progressive(handler_input, request, phrase):
    if not request.request_id:
        return
    try:
        directive_request = SendDirectiveRequest(
            header=Header(request_id=request.request_id),
            directive=SpeakDirective(speech=phrase),
        )
        directive_service = handler_input.service_client_factory.get_directive_service()
        directive_service.enqueue(directive_request)
    except Exception as e:
        logger.warning("Progressive Response fehlgeschlagen: %s", e)


def lambda_trace(session_id, event, elapsed_ms=None):
    """Fire-and-forget: Lambda-Lebenszyklus ins Gateway-Log (CloudWatch-Ersatz)."""
    if not gateway_url:
        return

    def run():
        try:
            requests.post(
                "{}/api/lambda-trace".format(gateway_url),
                headers={
                    "Authorization": "Bearer {}".format(api_token),
                    "Content-Type": "application/json",
                },
                json={"sessionId": session_id, "event": event, "elapsedMs": elapsed_ms},
                timeout=2,
            )
        except Exception as e:
            logger.warning("lambda-trace fehlgeschlagen: %s", e)

    threading.Thread(target=run, daemon=True).start()


class LaunchRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("LaunchRequest")(handler_input)

    def handle(self, handler_input):
        welcome = t(handler_input, "welcome")
        return (
            handler_input.response_builder
            .speak(welcome)
            .set_card(SimpleCard(title=CARD_TITLE, content=welcome))
            .ask(welcome)
            .response
        )


class GptQueryIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("GptQueryIntent")(handler_input)

    def handle(self, handler_input):
        request = handler_input.request_envelope.request
        session = handler_input.request_envelope.session
        response_builder = handler_input.response_builder

        slots = request.intent.slots or {}
        slot = slots.get("query")
        query = (slot.value if slot else None) or ""
        if not query.strip():
            logger.info("GptQueryIntent ohne query-Slot empfangen")
            return response_builder.speak(t(handler_input, "no_query")).set_should_end_session(False).response
        session_id = session.session_id if session else "unknown"
        user_id = None
        if session and session.user:
            user_id = session.user.user_id

        # Kein Klartext der Nutzerfrage ins Log (PII): nur die Laenge.
        logger.info("Query empfangen: %d Zeichen", len(query))
        trace_start = time.monotonic()
        lambda_trace(session_id, "invoke", 0)

        if acknowledgment_enabled:
            send_progressive(handler_input, request, t(handler_input, "processing"))

        result = {}

        app_id = _application_id()

        def run():
            try:
                result["value"] = call_gateway(query, session_id, user_id, app_id)
            except Exception as e:
                result["error"] = e

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(watchdog_delay)
        if worker.is_alive():
            if warteton_enabled:
                logger.info("Watchdog nach %.1fs ohne Gateway-Antwort, sende Warteton", watchdog_delay)
                send_progressive(handler_input, request, warteton_phrase or t(handler_input, "warteton"))
                worker.join(max(0.0, gateway_timeout - watchdog_delay))
            else:
                worker.join(max(0.0, ALEXA_WINDOW - watchdog_delay))
        if worker.is_alive():
            logger.error("Gateway-Antwort %.1fs ueberschritten", gateway_timeout)
            phrase = t(handler_input, "error_timeout")
            # Session offen lassen: direkt erneut fragen, ohne neu zu starten.
            return response_builder.speak(phrase).ask(phrase).set_should_end_session(False).response
        if "error" in result:
            logger.error("Gateway-Fehler: %s", result["error"], exc_info=True)
            phrase = t(handler_input, "error_timeout" if _is_timeout(result["error"]) else "error_unreachable")
            return response_builder.speak(phrase).ask(phrase).set_should_end_session(False).response

        speech, follow_up, is_ssml, display_text, followup_prompt = result["value"]

        logger.info(
            "Gateway-Antwort: %d Zeichen, ssml=%s, followUp=%s",
            len(speech), is_ssml, follow_up,
        )

        keep_open = follow_up or ask_for_further_commands
        lambda_trace(session_id, "response_sent", int((time.monotonic() - trace_start) * 1000))
        # ask-sdk speak() wrappt in <speak> und trimmt vorhandenen Wrapper;
        # Klartext muss XML-escaped werden (SSML aus dem Gateway nicht)
        # Anzeige: Klartext ohne SSML-Tags (Echo Show / Alexa App)
        display = display_text or strip_ssml(speech)
        response_builder.speak(escape(speech) if not is_ssml else speech)
        response_builder.set_card(SimpleCard(title=CARD_TITLE, content=display))
        # APL: kontrollierte Schriftgroesse + manuell scrollbar auf Displays
        if supports_apl(handler_input):
            render_apl(handler_input, CARD_TITLE, display)
        else:
            logger.warning("Kein APL-Support erkannt - nur SimpleCard gesendet. Rohe Interfaces: %r",
                           ((getattr(_RAW_ENVELOPE, "value", None) or {})
                            .get("context", {}).get("System", {})
                            .get("device", {}).get("supportedInterfaces")))
        if keep_open:
            # Dynamische Rueckfrage vom Gateway (situativ), sonst statischer Hinweis
            return response_builder.ask(followup_prompt or t(handler_input, "help")).response
        return response_builder.set_should_end_session(True).response


class HelpIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.HelpIntent")(handler_input)

    def handle(self, handler_input):
        # Dynamische Hilfe aus dem Gateway (Vorgang "hilfe" kennt die
        # installierten Faehigkeiten); sonst statischer Fallback-Text.
        help_text = t(handler_input, "help")
        try:
            session = handler_input.request_envelope.session
            session_id = session.session_id if session else "unknown"
            user_id = session.user.user_id if session and session.user else None
            speech = call_gateway("hilfe", session_id, user_id, _application_id())[0]
            help_text = strip_ssml(speech) or help_text
        except Exception as e:
            logger.warning("Hilfe vom Gateway fehlgeschlagen: %s", e)
        return (
            handler_input.response_builder
            .speak(help_text)
            .set_card(SimpleCard(title=CARD_TITLE, content=help_text))
            .ask(help_text)
            .response
        )


class CancelOrStopIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.CancelIntent")(handler_input) or ask_utils.is_intent_name(
            "AMAZON.StopIntent"
        )(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(t(handler_input, "stop")).set_should_end_session(True).response


class FallbackIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.FallbackIntent")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(t(handler_input, "help")).ask(t(handler_input, "help")).response


class SessionEndedRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("SessionEndedRequest")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.response


class AplRuntimeErrorHandler(AbstractRequestHandler):
    """Alexa meldet APL-Renderfehler als eigenes Event - fuer CloudWatch-Diagnose."""

    def can_handle(self, handler_input):
        return ask_utils.is_request_type("Alexa.Presentation.APL.RuntimeError")(handler_input)

    def handle(self, handler_input):
        raw = (getattr(_RAW_ENVELOPE, "value", None) or {}).get("request") or {}
        logger.error("APL RuntimeError: %r", raw)
        return handler_input.response_builder.response


class CanFulfillIntentRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("CanFulfillIntentRequest")(handler_input)

    def handle(self, handler_input):
        intent = handler_input.request_envelope.request.intent
        intent_name = intent.name if intent else None
        if intent_name == "GptQueryIntent":
            return handler_input.response_builder.can_fulfill("YES").add_can_fulfill_intent("YES").response
        return handler_input.response_builder.can_fulfill("NO").add_can_fulfill_intent("NO").response


class CatchAllExceptionHandler(AbstractExceptionHandler):
    def can_handle(self, handler_input, exception):
        return True

    def handle(self, handler_input, exception):
        logger.error(exception, exc_info=True)
        return handler_input.response_builder.speak(t(handler_input, "error")).ask(t(handler_input, "error")).response


sb = CustomSkillBuilder(api_client=DefaultApiClient())
# Eingebauter Skill-ID-Verifier des ASK SDK: ist sb.skill_id gesetzt, lehnt
# CustomSkill.invoke jeden Request mit abweichender applicationId ab.
sb.skill_id = alexa_skill_id or None
if not alexa_skill_id:
    logger.warning("alexa_skill_id nicht gesetzt - applicationId wird nicht geprueft")
sb.add_request_handler(LaunchRequestHandler())
sb.add_request_handler(GptQueryIntentHandler())
sb.add_request_handler(HelpIntentHandler())
sb.add_request_handler(CancelOrStopIntentHandler())
sb.add_request_handler(FallbackIntentHandler())
sb.add_request_handler(SessionEndedRequestHandler())
sb.add_request_handler(AplRuntimeErrorHandler())
sb.add_request_handler(CanFulfillIntentRequestHandler())
sb.add_exception_handler(CatchAllExceptionHandler())

_ask_lambda_handler = sb.lambda_handler()


def lambda_handler(event, context):
    # rohes Event fuer supports_apl puffern, BEVOR ask-sdk es deserialisiert
    _RAW_ENVELOPE.value = event
    return _ask_lambda_handler(event, context)
