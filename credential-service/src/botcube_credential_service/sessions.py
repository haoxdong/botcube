"""A site provider's Session Credentials: cached per account, re-minted from the vaulted Durable Credential."""

from __future__ import annotations

import hashlib
import hmac
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future
from copy import deepcopy
from threading import Lock
from typing import Any, Protocol

from .audit import CredentialAuditRecorder
from .vault import CredentialServiceError, CredentialVault, require_account_id

# The Durable Credential in, the re-minted session's cookie jar (`{'cookies': [...], 'updatedAt': ...}`) out.
SessionReminter = Callable[[str], Mapping[str, Any]]
# Whether cookies hold a session that is live at a time.
LiveSession = Callable[[Sequence[object], float], bool]
# Whether a cookie is the Durable Credential itself, which never leaves the Credential Service.
DurableCookie = Callable[[Mapping[str, object]], bool]


class SessionVault(CredentialVault, Protocol):
    def store_durable_credential(self, account_id: str, provider: str, durable_credential: str) -> str:
        ...

    def credential_revision(self, account_id: str, provider: str) -> str | None:
        ...


class SessionCache:
    """Decrypt the Durable Credential, re-mint a session from it, and hand out only the session's cookies.

    One re-mint runs per account and session generation: parallel requests on a cold cache share it and its
    failure, while a request after an invalidation or a new Sign-in starts its own. A Sign-in's revision fences
    every write, so a session minted from a replaced credential is never published.
    """

    def __init__(
        self,
        *,
        vault: SessionVault,
        reminter: SessionReminter,
        provider: str,
        site: str,
        live: LiveSession,
        durable: DurableCookie = lambda cookie: False,
        audit: CredentialAuditRecorder | None = None,
    ) -> None:
        self.vault = vault
        self.reminter = reminter
        self.provider = provider
        # The site's name in errors, as in 'no usable <site> session'.
        self.site = site
        self._live = live
        self._durable = durable
        self.audit = audit or CredentialAuditRecorder()
        self._session_cache: dict[str, dict[str, Any]] = {}
        self._session_generations: dict[str, object] = {}
        self._sign_in_generations: dict[str, str] = {}
        self._pending_session_cookies: dict[str, list[object]] = {}
        self._vaulted_digests: dict[str, tuple[bytes, str]] = {}
        self._session_lock = Lock()
        self._account_locks: dict[str, Lock] = {}
        self._remints: dict[str, tuple[object | None, Future[tuple[dict[str, Any], object | None]]]] = {}

    def _account_lock(self, account: str) -> Lock:
        with self._session_lock:
            return self._account_locks.setdefault(account, Lock())

    def has_session(self, cookies: object, *, now: float | None = None) -> bool:
        if not isinstance(cookies, Sequence) or isinstance(cookies, str | bytes | bytearray):
            return False
        return self._live(cookies, time.time() if now is None else now)

    def session_cookies(self, cookies: Sequence[object]) -> list[object]:
        """The cookies less the Durable Credential."""
        return [cookie for cookie in cookies if not (isinstance(cookie, Mapping) and self._durable(cookie))]

    def store_linked_credential(
        self,
        account_id: str,
        durable_credential: str,
        session_cookies: Sequence[object],
        request_context: Mapping[str, Any] | None = None,  # reserved for audit context
    ) -> None:
        """Vault a Sign-in's Durable Credential, and warm the cache from that Sign-in's own live session.

        The Durable Credential this process already vaulted for the account only refreshes its session, so a
        re-mint in flight stays valid.
        """
        account = require_account_id(account_id)
        cookies = deepcopy(self.session_cookies(session_cookies))
        digest = hashlib.sha256(durable_credential.encode()).digest()
        with self._account_lock(account):
            vaulted = self._vaulted_digests.get(account)
            current = self.vault.credential_revision(account, self.provider)
            if (vaulted is None or not hmac.compare_digest(vaulted[0], digest)
                    or vaulted[1] != current or self._sign_in_generations.get(account) != current):
                revision = self.vault.store_durable_credential(account, self.provider, durable_credential)
                if self.vault.credential_revision(account, self.provider) != revision:
                    raise CredentialServiceError('Credential changed during linking; retry the request')
                self._session_generations[account] = object()
                self._sign_in_generations[account] = revision
                self._pending_session_cookies.pop(account, None)
                self._session_cache.pop(account, None)
                self._vaulted_digests[account] = (digest, revision)
            if self.has_session(cookies):
                self._session_cache[account] = {'cookies': cookies, 'updatedAt': int(time.time())}

    def session_cookie_jar(
        self,
        account_id: str,
        request_context: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        jar, _ = self.session_cookie_snapshot(account_id, request_context)
        return jar

    def session_cookie_snapshot(
        self,
        account_id: str,
        request_context: Mapping[str, Any] | None = None,
    ) -> tuple[dict[str, Any], object | None]:
        """The account's live session, re-minted when none is cached, and the Sign-in revision it came from."""
        account = require_account_id(account_id)
        now = time.time()
        with self._account_lock(account):
            sign_in_generation = self.vault.credential_revision(account, self.provider)
            if self._sign_in_generations.get(account) != sign_in_generation:
                self._session_generations[account] = object()
                self._session_cache.pop(account, None)
                self._pending_session_cookies.pop(account, None)
                if sign_in_generation is not None:
                    self._sign_in_generations[account] = sign_in_generation
                else:
                    self._sign_in_generations.pop(account, None)
            generation = self._session_generations.get(account)
            cached = self._session_cache.get(account)
            if cached is not None and self.has_session(cached.get('cookies'), now=now):
                return deepcopy(cached), sign_in_generation
            flight = self._remints.get(account)
            leads = flight is None or flight[0] is not generation
            if flight is None or leads:
                flight = self._remints[account] = (generation, Future())
        result = flight[1]
        if not leads:
            jar, flight_generation = result.result()
            return deepcopy(jar), flight_generation
        try:
            snapshot = self._remint_snapshot(account, request_context, now, generation, sign_in_generation)
        except BaseException as exc:
            result.set_exception(exc)
            raise
        else:
            result.set_result(snapshot)
            return deepcopy(snapshot[0]), snapshot[1]
        finally:
            with self._account_lock(account):
                if self._remints.get(account) is flight:
                    del self._remints[account]

    def _remint_snapshot(
        self,
        account: str,
        request_context: Mapping[str, Any] | None,
        now: float,
        generation: object | None,
        sign_in_generation: str | None,
    ) -> tuple[dict[str, Any], object | None]:
        stored = self.vault.load_revised_credential(
            account,
            self.provider,
            audit=self.audit,
            request_context=request_context,
        )
        self.audit.record_session_remint(account, request_context)
        jar = self.reminter(stored.value)
        cookies = jar.get('cookies')
        if not isinstance(cookies, list):
            raise CredentialServiceError('Session re-mint returned an invalid cookie jar')
        session_cookies = self.session_cookies(cookies)
        if not self.has_session(session_cookies, now=now):
            raise CredentialServiceError(f'Session re-mint returned no usable {self.site} session')
        result = {
            'cookies': session_cookies,
            'updatedAt': jar.get('updatedAt', int(now)),
        }
        with self._account_lock(account):
            if (self._session_generations.get(account) is not generation
                    or self.vault.credential_revision(account, self.provider) != sign_in_generation
                    or stored.revision != sign_in_generation):
                raise CredentialServiceError('Credential changed during session re-mint; retry the request')
            published = self._session_cache.get(account)
            if published is not None and self.has_session(published.get('cookies'), now=time.time()):
                return deepcopy(published), sign_in_generation
            pending = self._pending_session_cookies.pop(account, [])
            if pending:
                result['cookies'] = self.merge_session_cookies(result['cookies'], pending)
                result['updatedAt'] = int(time.time())
            self._session_cache[account] = deepcopy(result)
            return deepcopy(result), sign_in_generation

    def has_live_session(self, account_id: str) -> bool:
        """Whether a live session from the vaulted credential is cached; nothing is decrypted or re-minted."""
        account = require_account_id(account_id)
        with self._account_lock(account):
            cached = self._session_cache.get(account)
            return cached is not None and self.has_session(cached.get('cookies'))

    def durable_credential(
        self,
        account_id: str,
        request_context: Mapping[str, Any] | None = None,
    ) -> str:
        """Decrypt the Durable Credential for one hop inside the Credential Service."""
        return self.vault.load_durable_credential(
            require_account_id(account_id),
            self.provider,
            audit=self.audit,
            request_context=request_context,
        )

    def update_session_cookies(
        self,
        account_id: str,
        cookies: Sequence[object],
        request_context: Mapping[str, Any] | None = None,  # reserved for audit context
        *,
        expected_generation: object | None,
    ) -> None:
        """Merge or keep a refresh while its originating Sign-in revision is current."""
        account = require_account_id(account_id)
        with self._account_lock(account):
            if self.vault.credential_revision(account, self.provider) != expected_generation:
                raise CredentialServiceError('Credential changed during session refresh; retry the request')
            cached = self._session_cache.get(account)
            if cached is None:
                pending = self._pending_session_cookies.get(account, [])
                self._pending_session_cookies[account] = self.merge_session_cookies(pending, cookies)
                return
            cached['cookies'] = self.merge_session_cookies(cached['cookies'], cookies)
            cached['updatedAt'] = int(time.time())

    def invalidate_session(
        self, account_id: str, *, expected_cookies: Sequence[object] | None = None,
    ) -> None:
        """Discard an expired session without changing the Sign-in revision; only the expected one, when named."""
        account = require_account_id(account_id)
        with self._account_lock(account):
            if expected_cookies is not None:
                cached = self._session_cache.get(account)
                if cached is None or any(
                    cookie not in cached['cookies'] for cookie in expected_cookies
                ):
                    return
            self._session_generations[account] = object()
            self._session_cache.pop(account, None)

    def delete_linked_credential(self, account_id: str) -> None:
        account = require_account_id(account_id)
        with self._account_lock(account):
            self.vault.delete_durable_credential(account, self.provider)
            self._vaulted_digests.pop(account, None)
            self._session_generations[account] = object()
            self._sign_in_generations.pop(account, None)
            self._pending_session_cookies.pop(account, None)
            self._session_cache.pop(account, None)

    def merge_session_cookies(self, cached_cookies: Sequence[object], cookies: Sequence[object]) -> list[object]:
        """The cached cookies with each refreshed one replacing the cookie of its name, domain and path."""
        merged = deepcopy(list(cached_cookies))
        positions = {
            _session_cookie_identity(cookie): index
            for index, cookie in enumerate(merged)
            if isinstance(cookie, Mapping)
        }
        for cookie in self.session_cookies(cookies):
            if not isinstance(cookie, Mapping):
                continue
            name = cookie.get('name')
            value = cookie.get('value')
            if not isinstance(name, str) or not name or not isinstance(value, str):
                continue
            entry = deepcopy(dict(cookie))
            identity = _session_cookie_identity(entry)
            position = positions.get(identity)
            if position is None:
                positions[identity] = len(merged)
                merged.append(entry)
            else:
                merged[position] = entry
        return merged


def _session_cookie_identity(cookie: Mapping[str, object]) -> tuple[object, object, object]:
    return cookie.get('name'), cookie.get('domain', ''), cookie.get('path', '/')
