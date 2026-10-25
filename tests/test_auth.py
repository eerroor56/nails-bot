import time

import pytest

from app.auth import InitDataError, validate_init_data

from .conftest import BOT_TOKEN, make_init_data

USER = {"id": 42, "first_name": "Анна", "last_name": "Иванова", "username": "anna"}


def test_valid_init_data():
    user = validate_init_data(make_init_data(USER), BOT_TOKEN)
    assert user.id == 42
    assert user.full_name == "Анна Иванова"
    assert user.username == "anna"


def test_wrong_token_rejected():
    with pytest.raises(InitDataError, match="подпись"):
        validate_init_data(make_init_data(USER, token="999:OTHER"), BOT_TOKEN)


def test_tampered_data_rejected():
    init_data = make_init_data(USER).replace("%22id%22%3A42", "%22id%22%3A43")
    assert init_data != make_init_data(USER)
    with pytest.raises(InitDataError):
        validate_init_data(init_data, BOT_TOKEN)


def test_expired_init_data_rejected():
    old = make_init_data(USER, auth_date=int(time.time()) - 2 * 86400)
    with pytest.raises(InitDataError, match="устарела"):
        validate_init_data(old, BOT_TOKEN, max_age=86400)


def test_missing_hash_rejected():
    with pytest.raises(InitDataError):
        validate_init_data("user=%7B%22id%22%3A1%7D&auth_date=1", BOT_TOKEN)
