import type { Key, KeyType } from '../../crypto'
import type { W3cVerifyCredentialResult } from './models'
import type {
  CreatePresentationOptions,
  DeriveProofOptions,
  SignCredentialOptions,
  SignPresentationOptions,
  StoreCredentialOptions,
  VerifyCredentialOptions,
  VerifyPresentationOptions,
} from './models/W3cCredentialServiceOptions'
import type { VerifyPresentationResult } from './models/presentation/VerifyPresentationResult'

import jsonld, { expand, frame } from '@digitalcredentials/jsonld'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import documentLoaderNode from '@digitalcredentials/jsonld/lib/documentLoaders/node'
import vc from '@digitalcredentials/vc'
import { deriveProof } from '@mattrglobal/jsonld-signatures-bbs'
import { inject, Lifecycle, scoped } from 'tsyringe'

import { AgentConfig } from '../../agent/AgentConfig'
import { createWalletKeyPairClass } from '../../crypto/WalletKeyPair'
import { AriesFrameworkError } from '../../error'
import { Logger } from '../../logger'
import { JsonTransformer, orArrayToArray } from '../../utils'
import { uuid } from '../../utils/uuid'
import { Wallet } from '../../wallet'
import { DidResolverService, VerificationMethod } from '../dids'
import { getKeyDidMappingByVerificationMethod } from '../dids/domain/key-type'

import { SignatureSuiteRegistry } from './SignatureSuiteRegistry'
import { W3cVerifiableCredential } from './models'
import { W3cCredentialRecord } from './models/credential/W3cCredentialRecord'
import { W3cCredentialRepository } from './models/credential/W3cCredentialRepository'
import { W3cPresentation } from './models/presentation/W3Presentation'
import { W3cVerifiablePresentation } from './models/presentation/W3cVerifiablePresentation'

@scoped(Lifecycle.ContainerScoped)
export class W3cCredentialService {
  private wallet: Wallet
  private w3cCredentialRepository: W3cCredentialRepository
  private didResolver: DidResolverService
  private agentConfig: AgentConfig
  private logger: Logger
  private suiteRegistry: SignatureSuiteRegistry

  public constructor(
    @inject('Wallet') wallet: Wallet,
    w3cCredentialRepository: W3cCredentialRepository,
    didResolver: DidResolverService,
    agentConfig: AgentConfig,
    logger: Logger
  ) {
    this.wallet = wallet
    this.w3cCredentialRepository = w3cCredentialRepository
    this.didResolver = didResolver
    this.agentConfig = agentConfig
    this.logger = logger
    this.suiteRegistry = new SignatureSuiteRegistry()
  }

  /**
   * Signs a credential
   *
   * @param credential the credential to be signed
   * @returns the signed credential
   */
  public async signCredential(options: SignCredentialOptions): Promise<W3cVerifiableCredential> {
    const WalletKeyPair = createWalletKeyPairClass(this.wallet)

    const signingKey = await this.getPublicKeyFromVerificationMethod(options.verificationMethod)
    const suiteInfo = this.suiteRegistry.getByProofType(options.proofType)

    if (signingKey.keyType !== suiteInfo.keyType) {
      throw new AriesFrameworkError('The key type of the verification method does not match the suite')
    }

    const keyPair = new WalletKeyPair({
      controller: options.credential.issuerId, // should we check this against the verificationMethod.controller?
      id: options.verificationMethod,
      key: signingKey,
      wallet: this.wallet,
    })

    const SuiteClass = suiteInfo.suiteClass

    const suite = new SuiteClass({
      key: keyPair,
      LDKeyClass: WalletKeyPair,
      proof: {
        verificationMethod: options.verificationMethod,
      },
      useNativeCanonize: false,
      date: options.created ?? new Date().toISOString(),
    })

    const result = await vc.issue({
      credential: JsonTransformer.toJSON(options.credential),
      suite: suite,
      purpose: options.proofPurpose,
      documentLoader: this.documentLoader,
    })

    return JsonTransformer.fromJSON(result, W3cVerifiableCredential)
  }

  /**
   * Verifies the signature(s) of a credential
   *
   * @param credential the credential to be verified
   * @returns the verification result
   */
  public async verifyCredential(options: VerifyCredentialOptions): Promise<W3cVerifyCredentialResult> {
    // create keyPair
    const WalletKeyPair = createWalletKeyPairClass(this.wallet)

    let proofs = options.credential.proof

    if (!Array.isArray(proofs)) {
      proofs = [proofs]
    }

    const suites = proofs.map((x) => {
      const SuiteClass = this.suiteRegistry.getByProofType(x.type)?.suiteClass
      if (SuiteClass) {
        return new SuiteClass({
          LDKeyClass: WalletKeyPair,
          proof: {
            verificationMethod: x.verificationMethod,
          },
          date: x.created,
          useNativeCanonize: false,
        })
      }
    })

    const verifyOptions: Record<string, any> = {
      credential: JsonTransformer.toJSON(options.credential),
      suite: suites,
      documentLoader: this.documentLoader,
    }

    // this is a hack because vcjs throws if purpose is passed as undefined or null
    if (options.proofPurpose) {
      verifyOptions['purpose'] = options.proofPurpose
    }

    const result = await vc.verifyCredential(verifyOptions)

    return result as unknown as W3cVerifyCredentialResult
  }

  /**
   * Writes a credential to storage
   *
   * @param record the credential to be stored
   * @returns the credential record that was written to storage
   */
  public async storeCredential(options: StoreCredentialOptions): Promise<W3cCredentialRecord> {
    // Get the expanded types
    const expandedTypes = (
      await expand(JsonTransformer.toJSON(options.record), { documentLoader: this.documentLoader })
    )[0]['@type']

    // Create an instance of the w3cCredentialRecord
    const w3cCredentialRecord = new W3cCredentialRecord({
      tags: { expandedTypes: orArrayToArray(expandedTypes) },
      credential: options.record,
    })

    // Store the w3c credential record
    await this.w3cCredentialRepository.save(w3cCredentialRecord)

    return w3cCredentialRecord
  }

  /**
   * Utility method that creates a {@link W3cPresentation} from one or more {@link W3cVerifiableCredential}s.
   *
   * **NOTE: the presentation that is returned is unsigned.**
   *
   * @param credentials One or more instances of {@link W3cVerifiableCredential}
   * @param [id] an optional unique identifier for the presentation
   * @param [holderUrl] an optional identifier identifying the entity that is generating the presentation
   * @returns An instance of {@link W3cPresentation}
   */
  public async createPresentation(options: CreatePresentationOptions): Promise<W3cPresentation> {
    if (!Array.isArray(options.credentials)) {
      options.credentials = [options.credentials]
    }

    const presentationJson = vc.createPresentation({
      verifiableCredential: options.credentials.map((x) => JsonTransformer.toJSON(x)),
      id: options.id,
      holder: options.holderUrl,
    })

    return JsonTransformer.fromJSON(presentationJson, W3cPresentation)
  }

  /**
   * Signs a presentation including the credentials it includes
   *
   * @param presentation the presentation to be signed
   * @returns the signed presentation
   */
  public async signPresentation(options: SignPresentationOptions): Promise<W3cVerifiablePresentation> {
    // create keyPair
    const WalletKeyPair = createWalletKeyPairClass(this.wallet)

    const suiteInfo = this.suiteRegistry.getByProofType(options.signatureType)

    if (!suiteInfo) {
      throw new AriesFrameworkError(`The requested proofType ${options.signatureType} is not supported`)
    }

    const signingKey = await this.getPublicKeyFromVerificationMethod(options.verificationMethod)

    if (signingKey.keyType !== suiteInfo.keyType) {
      throw new AriesFrameworkError('The key type of the verification method does not match the suite')
    }

    const verificationMethodObject = (await this.documentLoader(options.verificationMethod)).document as Record<
      string,
      any
    >

    const keyPair = new WalletKeyPair({
      controller: verificationMethodObject['controller'],
      id: options.verificationMethod,
      key: signingKey,
      wallet: this.wallet,
    })

    const suite = new suiteInfo.suiteClass({
      LDKeyClass: WalletKeyPair,
      proof: {
        verificationMethod: options.verificationMethod,
      },
      date: new Date().toISOString(),
      key: keyPair,
      useNativeCanonize: false,
    })

    const result = await vc.signPresentation({
      presentation: JsonTransformer.toJSON(options.presentation),
      suite: suite,
      challenge: uuid(),
      documentLoader: this.documentLoader,
    })

    return JsonTransformer.fromJSON(result, W3cVerifiablePresentation)
  }

  /**
   * Verifies a presentation including the credentials it includes
   *
   * @param presentation the presentation to be verified
   * @returns the verification result
   */
  public async verifyPresentation(options: VerifyPresentationOptions): Promise<VerifyPresentationResult> {
    // create keyPair
    const WalletKeyPair = createWalletKeyPairClass(this.wallet)

    let proofs = options.presentation.proof

    if (!Array.isArray(proofs)) {
      proofs = [proofs]
    }
    if (options.purpose) {
      proofs = proofs.filter((x) => x.proofPurpose === options.purpose.term)
    }

    const suites = proofs.map((x) => {
      const SuiteClass = this.suiteRegistry.getByProofType(x.type).suiteClass
      return new SuiteClass({
        LDKeyClass: WalletKeyPair,
        proof: {
          verificationMethod: x.verificationMethod,
        },
        date: x.created,
        useNativeCanonize: false,
      })
    })

    const verifyOptions: Record<string, any> = {
      presentation: JsonTransformer.toJSON(options.presentation),
      suite: suites,
      challenge: options.challenge,
      documentLoader: this.documentLoader,
    }

    // this is a hack because vcjs throws if purpose is passed as undefined or null
    if (options.purpose) {
      verifyOptions['presentationPurpose'] = options.purpose
    }

    const result = await vc.verify(verifyOptions)

    return result as unknown as VerifyPresentationResult
  }

  public async deriveProof(options: DeriveProofOptions): Promise<W3cVerifiableCredential> {
    const suiteInfo = this.suiteRegistry.getByProofType('BbsBlsSignatureProof2020')
    const SuiteClass = suiteInfo.suiteClass

    const suite = new SuiteClass()

    const proof = await deriveProof(JsonTransformer.toJSON(options.credential), options.revealDocument, {
      suite: suite,
      documentLoader: this.documentLoader,
    })

    return proof
  }

  public documentLoader = async (url: string): Promise<Record<string, any>> => {
    if (url.startsWith('did:')) {
      const result = await this.didResolver.resolve(url)

      if (result.didResolutionMetadata.error || !result.didDocument) {
        // TODO: we should probably handle this more gracefully
        throw new AriesFrameworkError(`Unable to resolve DID: ${url}`)
      }

      const framed = await frame(result.didDocument.toJSON(), {
        '@context': result.didDocument.context,
        '@embed': '@never',
        id: url,
      })

      return {
        contextUrl: null,
        documentUrl: url,
        document: framed,
      }
    }

    const loader = documentLoaderNode.apply(jsonld, [])

    return await loader(url)
  }

  private async getPublicKeyFromVerificationMethod(verificationMethod: string): Promise<Key> {
    const verificationMethodObject = await this.documentLoader(verificationMethod)
    const verificationMethodClass = JsonTransformer.fromJSON(verificationMethodObject.document, VerificationMethod)

    const key = getKeyDidMappingByVerificationMethod(verificationMethodClass)

    return key.getKeyFromVerificationMethod(verificationMethodClass)
  }
}