"""Synthetic disposable TLS fixture. Requires cryptography; no private config."""
import datetime
import ipaddress
import pathlib
import sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

directory = pathlib.Path(sys.argv[1])
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "isolated-probe-test")])
now = datetime.datetime.now(datetime.timezone.utc)
certificate = (
    x509.CertificateBuilder()
    .subject_name(name).issuer_name(name).public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(minutes=1))
    .not_valid_after(now + datetime.timedelta(days=1))
    .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    .add_extension(x509.SubjectAlternativeName([
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")), x509.DNSName("localhost")
    ]), critical=False)
    .sign(key, hashes.SHA256())
)
(directory / "server.key").write_bytes(key.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
))
(directory / "server.crt").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
