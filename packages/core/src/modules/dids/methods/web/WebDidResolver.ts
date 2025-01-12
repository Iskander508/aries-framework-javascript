import type { DidResolver } from '../../domain/DidResolver'
import type { ParsedDid, DidResolutionResult, DidResolutionOptions } from '../../types'

import { Resolver } from 'did-resolver'
import * as didWeb from 'web-did-resolver'

import { JsonTransformer } from '../../../../utils/JsonTransformer'
import { MessageValidator } from '../../../../utils/MessageValidator'
import { DidDocument } from '../../domain'

export class WebDidResolver implements DidResolver {
  public readonly supportedMethods

  // FIXME: Would be nice if we don't have to provide a did resolver instance
  private _resolverInstance = new Resolver()
  private resolver = didWeb.getResolver()

  public constructor() {
    this.supportedMethods = Object.keys(this.resolver)
  }

  public async resolve(
    did: string,
    parsed: ParsedDid,
    didResolutionOptions: DidResolutionOptions
  ): Promise<DidResolutionResult> {
    const result = await this.resolver[parsed.method](did, parsed, this._resolverInstance, didResolutionOptions)

    let didDocument = null
    if (result.didDocument) {
      didDocument = JsonTransformer.fromJSON(result.didDocument, DidDocument)
      await MessageValidator.validate(didDocument)
    }

    return {
      ...result,
      didDocument,
    }
  }
}
