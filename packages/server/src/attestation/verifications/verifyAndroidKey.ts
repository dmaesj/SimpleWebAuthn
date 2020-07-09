import type { AttestationStatement } from '../../helpers/decodeAttestationObject';
import convertASN1toPEM from '../../helpers/convertASN1toPEM';
import verifySignature from '../../helpers/verifySignature';
import { leafCertToASN1Object, findOID, ASN1Object, JASN1 } from '../../helpers/asn1Utils';
import convertCOSEtoPKCS, { COSEALGHASH } from '../../helpers/convertCOSEtoPKCS';
import parseCertificateASN1 from '../../helpers/parseCertificateBuffer';
import MetadataService from '../../metadata/metadataService';
import verifyAttestationWithMetadata from '../../metadata/verifyAttestationWithMetadata';

type Options = {
  authData: Buffer;
  clientDataHash: Buffer;
  attStmt: AttestationStatement;
  credentialPublicKey: Buffer;
  aaguid: Buffer;
};

export default async function verifyAttestationAndroidKey(options: Options): Promise<boolean> {
  const { authData, clientDataHash, attStmt, credentialPublicKey, aaguid } = options;
  const { x5c, sig, alg } = attStmt;

  if (!x5c) {
    throw new Error('No attestation certificate provided in attestation statement (AndroidKey)');
  }

  if (!sig) {
    throw new Error('No attestation signature provided in attestation statement (AndroidKey)');
  }

  if (!alg) {
    throw new Error(`Attestation statement did not contain alg (AndroidKey)`);
  }

  const certASN1 = leafCertToASN1Object(x5c[0]);

  // Check that credentialPublicKey matches the public key in the attestation certificate
  // Find the public cert in the certificate as PKCS
  const parsedCert = parseCertificateASN1(x5c[0]);
  console.log('extensions:', parsedCert.tbsCertificate.extensions);
  const parsedCertPubKey = Buffer.from(
    parsedCert.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey,
  );

  // Convert the credentialPublicKey to PKCS
  const credPubKeyPKCS = convertCOSEtoPKCS(credentialPublicKey);

  if (!credPubKeyPKCS.equals(parsedCertPubKey)) {
    throw new Error('Credential public key does not equal leaf cert public key (AndroidKey)');
  }

  // Find Android KeyStore Extension in certificate extensions
  const extKeyStore = getASN1ExtKeyStore(certASN1);

  if (!extKeyStore) {
    throw new Error('Certificate did not contain extKeyStore (AndroidKey)');
  }

  // Verify extKeyStore values
  const { attestationChallenge, teeEnforced, softwareEnforced } = extKeyStore;

  if (!attestationChallenge.equals(clientDataHash)) {
    throw new Error('Attestation challenge was not equal to client data hash (AndroidKey)');
  }

  // Ensure that the key is strictly bound to the caller app identifier (shouldn't contain the
  // following tag)
  const allApplicationsTag = '[600]';

  if (teeEnforced.indexOf(allApplicationsTag) >= 0) {
    throw new Error('teeEnforced contained "[600]" tag (AndroidKey)');
  }

  if (softwareEnforced.indexOf(allApplicationsTag) >= 0) {
    throw new Error('teeEnforced contained "[600]" tag (AndroidKey)');
  }

  // TODO: Confirm that the root certificate is an expected certificate
  // const rootCertPEM = convertASN1toPEM(x5c[x5c.length - 1]);
  // console.log(rootCertPEM);

  // if (rootCertPEM !== expectedRootCert) {
  //   throw new Error('Root certificate was not expected certificate (AndroidKey)');
  // }

  const statement = await MetadataService.getStatement(aaguid);
  if (statement) {
    try {
      await verifyAttestationWithMetadata(statement, alg, x5c);
    } catch (err) {
      throw new Error(`${err.message} (AndroidKey)`);
    }
  }

  const signatureBase = Buffer.concat([authData, clientDataHash]);
  const leafCertPEM = convertASN1toPEM(x5c[0]);
  const hashAlg = COSEALGHASH[alg as number];

  return verifySignature(sig, signatureBase, leafCertPEM, hashAlg);
}

type KeyStoreExtensionDescription = {
  attestationVersion: number;
  attestationChallenge: Buffer;
  softwareEnforced: string[];
  teeEnforced: string[];
};

function getASN1ExtKeyStore(certASN1: ASN1Object): KeyStoreExtensionDescription | undefined {
  const oid = '1.3.6.1.4.1.11129.2.1.17';
  const ext = findOID(certASN1, oid);

  if (!ext) {
    return;
  }

  const description = (ext.data as JASN1[])[1];
  const descData = (description.data as JASN1[])[0].data;

  if (!descData) {
    return;
  }

  /**
   * Cast to number according to RFC 5280
   * https://tools.ietf.org/html/rfc5280#section-3.1
   */
  const rawAttestationVersion = (descData[0] as JASN1).data as string;
  let attestationVersion = 1;
  if (rawAttestationVersion === '1') {
    attestationVersion = 2;
  } else if (rawAttestationVersion === '2') {
    attestationVersion = 3;
  }

  const attestationChallenge = (descData[4] as JASN1).data as Buffer;
  const softwareEnforced = ((descData[6] as JASN1).data as JASN1[]).map(data => data.type);
  const teeEnforced = ((descData[7] as JASN1).data as JASN1[]).map(data => data.type);

  return {
    attestationVersion,
    attestationChallenge,
    softwareEnforced,
    teeEnforced,
  };
}

// TODO: Find the most up-to-date expected root cert, the one from Yuriy's article doesn't match
const expectedRootCert = ``;
