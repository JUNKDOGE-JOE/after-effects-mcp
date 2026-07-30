"""Retired operation-specific Text, Shape, and Marker request models."""

from decimal import Decimal, InvalidOperation
import math


def unicode_scalars(
    value: str,
    *,
    field: str,
    maximum: int,
    minimum: int = 0,
) -> str:
    if "\x00" in value or any(
        0xD800 <= ord(character) <= 0xDFFF for character in value
    ):
        raise ValueError(
            f"{field} must contain only non-NUL Unicode scalar values"
        )
    if not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{field} must contain {minimum}..{maximum} Unicode scalar values"
        )
    return value


def bounded_decimal(
    value: str,
    *,
    field: str,
    minimum: Decimal,
    maximum: Decimal,
    exclusive_minimum: bool = False,
) -> str:
    try:
        decimal = Decimal(value)
        binary = float(value)
    except (InvalidOperation, OverflowError, ValueError) as error:
        raise ValueError(f"{field} must be a finite canonical decimal") from error
    if not decimal.is_finite() or not math.isfinite(binary):
        raise ValueError(f"{field} must be a finite canonical decimal")
    if binary == 0 and (not decimal.is_zero() or value.startswith("-")):
        raise ValueError(
            f"{field} must be a canonical binary-convertible decimal"
        )
    below = decimal <= minimum if exclusive_minimum else decimal < minimum
    if below or decimal > maximum:
        raise ValueError(f"{field} is outside the frozen numeric range")
    return value


PUBLIC_SCHEMAS: dict[str, type] = {}
