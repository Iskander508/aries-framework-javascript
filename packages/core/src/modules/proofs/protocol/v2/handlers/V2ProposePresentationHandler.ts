import type { AgentConfig } from '../../../../../agent/AgentConfig'
import type { Handler, HandlerInboundMessage } from '../../../../../agent/Handler'
import type { DidCommMessageRepository } from '../../../../../storage'
import type { ProofResponseCoordinator } from '../../../ProofResponseCoordinator'
import type { ProofRequestFromProposalOptions } from '../../../models/ProofServiceOptions'
import type { ProofRecord } from '../../../repository/ProofRecord'
import type { V2ProofService } from '../V2ProofService'

import { createOutboundMessage } from '../../../../../agent/helpers'
import { AriesFrameworkError } from '../../../../../error/AriesFrameworkError'
import { V2_INDY_PRESENTATION_PROPOSAL } from '../../../formats/ProofFormats'
import { V2ProposalPresentationMessage } from '../messages/V2ProposalPresentationMessage'

export class V2ProposePresentationHandler implements Handler {
  private proofService: V2ProofService
  private agentConfig: AgentConfig
  private didCommMessageRepository: DidCommMessageRepository
  private proofResponseCoordinator: ProofResponseCoordinator
  public supportedMessages = [V2ProposalPresentationMessage]

  public constructor(
    proofService: V2ProofService,
    agentConfig: AgentConfig,
    didCommMessageRepository: DidCommMessageRepository,
    proofResponseCoordinator: ProofResponseCoordinator
  ) {
    this.proofService = proofService
    this.agentConfig = agentConfig
    this.didCommMessageRepository = didCommMessageRepository
    this.proofResponseCoordinator = proofResponseCoordinator
  }

  public async handle(messageContext: HandlerInboundMessage<V2ProposePresentationHandler>) {
    const proofRecord = await this.proofService.processProposal(messageContext)

    if (this.proofResponseCoordinator.shouldAutoRespondToProposal(proofRecord)) {
      return this.createRequest(proofRecord, messageContext)
    }
  }

  private async createRequest(
    proofRecord: ProofRecord,
    messageContext: HandlerInboundMessage<V2ProposePresentationHandler>
  ) {
    this.agentConfig.logger.info(
      `Automatically sending request with autoAccept on ${this.agentConfig.autoAcceptProofs}`
    )

    if (!messageContext.connection) {
      this.agentConfig.logger.error('No connection on the messageContext')
      return
    }

    const proposalMessage = await this.didCommMessageRepository.findAgentMessage({
      associatedRecordId: proofRecord.id,
      messageClass: V2ProposalPresentationMessage,
    })

    if (!proposalMessage) {
      this.agentConfig.logger.error(`Proof record with id ${proofRecord.id} is missing required credential proposal`)
      return
    }

    const proposalAttachment = proposalMessage
      .getAttachmentFormats()
      .find((x) => x.format.format === V2_INDY_PRESENTATION_PROPOSAL)

    if (!proposalAttachment) {
      throw new AriesFrameworkError('No proposal message could be found')
    }

    const proofRequestFromProposalOptions: ProofRequestFromProposalOptions = {
      name: 'proof-request',
      version: '1.0',
      nonce: await this.proofService.generateProofRequestNonce(),
      proofRecord,
    }

    const proofRequest = await this.proofService.createProofRequestFromProposal(proofRequestFromProposalOptions)

    if (!proofRequest.indy) {
      throw new AriesFrameworkError('Failed to create proof request')
    }

    const { message } = await this.proofService.createRequestAsResponse({
      proofRecord: proofRecord,
      autoAcceptProof: proofRecord.autoAcceptProof,
      proofFormats: proofRequest,
      willConfirm: true,
    })

    return createOutboundMessage(messageContext.connection, message)
  }
}