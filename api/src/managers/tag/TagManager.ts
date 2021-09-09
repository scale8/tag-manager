import Manager from '../../abstractions/Manager';
import { injectable } from 'inversify';
import { gql } from 'apollo-server-express';
import Tag from '../../mongo/models/tag/Tag';
import CTX from '../../gql/ctx/CTX';
import { ObjectId, ObjectID } from 'mongodb';
import RuleGroup from '../../mongo/models/tag/RuleGroup';
import Revision from '../../mongo/models/tag/Revision';
import GQLError from '../../errors/GQLError';
import OperationOwner from '../../enums/OperationOwner';
import GQLMethod from '../../enums/GQLMethod';
import userMessages from '../../errors/UserMessages';
import { createNewModelBranchFromModel, deleteModelCascading } from '../../utils/ModelUtils';
import { createTagSkeleton } from '../../utils/TagUtils';
import User from '../../mongo/models/User';
import TagRepo from '../../mongo/repos/tag/TagRepo';
import { TagType } from '../../enums/TagType';

@injectable()
export default class TagManager extends Manager<Tag> {
    protected gqlSchema = gql`
        """
        A tag can either be a \`HEAD\` tag or \`PLACEMENT\` tag, but can't be both. Please take a look at the descriptions of each below and select the one that fits your use case.
        """
        enum TagType {
            """
            Tag type HEAD will load this tag in the \`HEAD\` of the page. This is used calling libraries that **do not** require rendering a specific slot on the page. Width and height requirements will be ingored on HEAD tags.
            """
            HEAD
            """
            A PLACEMENT tag is used for rendering widgets, ads or other types of media where they are required to load in slot on the page. These tags will be loaded in the \`BODY\` of the page. A width and height is requirement for all PLACEMENT tags.
            """
            PLACEMENT
        }

        """
        @model
        Tags contain \`RuleGroup\`'s that describe under what events and conditions a tag execute certain actions.
        """
        type Tag {
            """
            Tag ID
            """
            id: ID!
            """
            Tag name
            """
            name: String!
            """
            Tag code, this persists when cloned. It is generated by the parent tag and inherited by all other tags cloned from this point. It is immutable by design.
            """
            tag_code: String!
            """
            Revision
            """
            revision: Revision!
            """
            Tag type, see \`TagType\`
            """
            type: TagType!
            """
            A set of \`RuleGroup\`s attached to this tag.
            """
            rule_groups: [RuleGroup!]!
            """
            An optional width parameter, used for placements.
            """
            width: Int!
            """
            An optional height parameter, used for placements.
            """
            height: Int!
            """
            If the tag should be automatically loaded on all pages.
            """
            auto_load: Boolean!
            """
            If the \`Tag\` is active or inactive. If this property is set to false, the tag will be ignored
            """
            is_active: Boolean!
            """
            Date the tag was created
            """
            created_at: DateTime!
            """
            Date the tag was last updated
            """
            updated_at: DateTime!
        }

        # noinspection GraphQLMemberRedefinition
        extend type Query {
            """
            @bound=Tag
            Get an Tag model from the Tag ID
            """
            getTag(id: ID!): Tag!
        }

        input TagCreateInput {
            """
            The \`Revision\` under which the \`Tag\` should be created
            """
            revision_id: ID!
            """
            The name of the new \`Tag\`
            """
            name: String!
            """
            The type of \`Tag\` to be created
            """
            type: TagType!
            """
            An optional width parameter, used for placements.
            """
            width: Int = 0
            """
            An optional height parameter, used for placements.
            """
            height: Int = 0
            """
            Auto-load tag. Only avalible to HEAD tags.
            """
            auto_load: Boolean = false
            """
            Any additional user comments for the audit
            """
            comments: String
        }

        input TagDuplicateInput {
            """
            \`Tag\` ID to clone against
            """
            tag_id: ID!
            """
            New name for the \`Tag\`
            """
            name: String!
        }

        input TagDeleteInput {
            """
            \`Tag\` ID to delete against
            """
            tag_id: ID!
            """
            If true, we can do a dry-run and check what the outcome of this delete will be before commiting to it
            """
            preview: Boolean = false
            """
            Any additional user comments for the audit
            """
            comments: String
        }

        """
        Update a \`Tag\`'s properties. Please note that \`TagType\` can't be changed once a tag has been created.
        """
        input TagUpdateInput {
            """
            \`Tag\` ID to update data against
            """
            tag_id: ID!
            """
            \`Tag\` name
            """
            name: String
            """
            If the \`Tag\` should be active or not
            """
            is_active: Boolean
            """
            \`Tag\` width, used for placements
            """
            width: Int
            """
            \`Tag\` height, used for placements
            """
            height: Int
            """
            Auto-load tag. Only avalible to HEAD tags.
            """
            auto_load: Boolean
            """
            Any additional user comments for the audit
            """
            comments: String
        }

        input TagRuleGroupOrderInput {
            """
            \`Tag\` ID to re-order rule groups against
            """
            tag_id: ID!
            """
            A new order of \`RuleGroup\`'s IDs
            """
            new_order: [ID!]!
        }

        # noinspection GraphQLMemberRedefinition
        extend type Mutation {
            """
            @bound=Tag
            Create a new \`Tag\`. \`Revision\` ID is required here to ensure \`Tag\` is placed inside the correct version
            """
            createTag(tagCreateInput: TagCreateInput!): Tag!
            """
            @bound=Tag
            Duplicate a new \`Tag\`. The duplicated will copy everything beneath \`Tag\`, creating a new \`Tag\` entity and linking it to the same Revision
            """
            duplicateTag(tagDuplicateInput: TagDuplicateInput!): Tag!
            """
            @bound=Tag
            Update a \`Tag\`'s details.
            """
            updateTag(tagUpdateInput: TagUpdateInput!): Boolean!
            """
            @bound=Tag
            Delete a \`Tag\` and its children.
            """
            deleteTag(tagDeleteInput: TagDeleteInput!): [ModelDeleteAcknowledgement!]!
            """
            @bound=Tag
            Update the order of \`RuleGroup\`'s curently linked to \`Tag\`
            """
            updateRuleGroupsOrder(tagRuleGroupOrderInput: TagRuleGroupOrderInput!): Boolean!
        }
    `;

    // noinspection JSUnusedGlobalSymbols
    /**
     * Mutation Resolvers
     * @protected
     */
    protected gqlExtendedMutationResolvers = {
        updateRuleGroupsOrder: async (parent: any, args: any, ctx: CTX) => {
            const data = args.tagRuleGroupOrderInput;
            const tag = await this.repoFactory(Tag).findByIdThrows(
                new ObjectId(data.tag_id),
                userMessages.tagFailed,
            );
            return this.orgAuth.asUserWithEditAccess(ctx, tag.orgId, async (me) => {
                //we need to cycle through existing set
                if (
                    tag.ruleGroupIds.length === data.new_order.length &&
                    tag.ruleGroupIds
                        .map((_) => _.toString())
                        .every((_) => data.new_order.indexOf(_) !== -1)
                ) {
                    //the length is the same and every item has been accounted for...
                    tag.ruleGroupIds = (data.new_order as string[]).map((_) => new ObjectId(_));
                    await this.repoFactory(Tag).save(tag, me, OperationOwner.USER, {
                        gqlMethod: GQLMethod.REORDER_LINKED_ENTITIES,
                        opConnectedModels: await this.repoFactory(RuleGroup).findByIds(
                            tag.ruleGroupIds,
                        ),
                    });
                    return true;
                } else {
                    throw new GQLError(userMessages.reOrderProblem, true);
                }
            });
        },
        deleteTag: async (parent: any, args: any, ctx: CTX) => {
            const data = args.tagDeleteInput;
            const tag = await this.repoFactory(Tag).findByIdThrows(
                new ObjectId(data.tag_id),
                userMessages.tagFailed,
            );
            return this.orgAuth.asUserWithDeleteAccess(ctx, tag.orgId, async (me) => {
                const previewMode = data.preview === true;
                if (!previewMode) {
                    //we need to first unlink...
                    const revision = await this.repoFactory(Revision).findByIdThrows(
                        tag.revisionId,
                        userMessages.revisionFailed,
                    );
                    revision.tagIds = revision.tagIds.filter((_) => !_.equals(tag.id));
                    await this.repoFactory(Revision).save(revision, me, OperationOwner.USER, {
                        gqlMethod: GQLMethod.DELETE_LINKED_ENTITY,
                        userComments: data.comments,
                        opConnectedModels: [tag],
                    });
                }
                return await deleteModelCascading(me, tag, previewMode);
            });
        },
        updateTag: async (parent: any, args: any, ctx: CTX) => {
            const data = args.tagUpdateInput;
            const tag = await this.repoFactory(Tag).findByIdThrows(
                new ObjectId(data.tag_id),
                userMessages.tagFailed,
            );
            return this.orgAuth.asUserWithEditAccess(ctx, tag.orgId, async (me) => {
                if (tag.type === TagType.PLACEMENT && data.auto_load === true) {
                    throw new GQLError('Auto-load can not be used with this placement type');
                }
                tag.bulkGQLSet(data, ['name', 'width', 'height', 'auto_load', 'is_active']); //only is a safety check against this function
                await this.repoFactory(Tag).save(tag, me, OperationOwner.USER, {
                    gqlMethod: GQLMethod.UPDATE_PROPERTIES,
                    userComments: data.comments,
                });
                return true;
            });
        },
        duplicateTag: async (parent: any, args: any, ctx: CTX) => {
            const duplicateTag = async (actor: User, tag: Tag): Promise<Tag> => {
                const revision = await this.repoFactory(Revision).findByIdThrows(
                    tag.revisionId,
                    userMessages.revisionFailed,
                );
                const newTag = await createNewModelBranchFromModel(actor, tag, TagRepo);
                revision.tagIds = [...revision.tagIds, newTag.id];
                await this.repoFactory(Revision).save(revision, actor, OperationOwner.USER, {
                    gqlMethod: GQLMethod.ADD_LINKED_ENTITY,
                    opConnectedModels: [newTag],
                });
                return newTag;
            };

            const data = args.tagDuplicateInput;
            const tag = await this.repoFactory(Tag).findByIdThrows(
                new ObjectId(data.tag_id),
                userMessages.tagFailed,
            );
            return this.orgAuth.asUserWithCreateAccess(ctx, tag.orgId, async (me) => {
                const duplicate = await duplicateTag(me, tag);
                duplicate.name = data.name;
                return (
                    await this.repoFactory(Tag).save(duplicate, me, OperationOwner.USER, {
                        gqlMethod: GQLMethod.UPDATE_PROPERTIES,
                        userComments: `Changed tag name to ${duplicate.name}`,
                    })
                ).toGQLType();
            });
        },
        createTag: async (parent: any, args: any, ctx: CTX) => {
            const data = args.tagCreateInput;
            const revision = await this.repoFactory(Revision).findByIdThrows(
                new ObjectId(data.revision_id),
                userMessages.revisionFailed,
            );
            return this.orgAuth.asUserWithCreateAccess(ctx, revision.orgId, async (me) => {
                if (data.type === TagType.PLACEMENT && data.auto_load === true) {
                    throw new GQLError('Auto-load can not be used with this placement type');
                }
                return (
                    await createTagSkeleton(
                        me,
                        revision,
                        data.name,
                        data.type,
                        data.width,
                        data.height,
                        data.auto_load,
                        data.comments,
                    )
                ).toGQLType();
            });
        },
    };

    // noinspection JSUnusedGlobalSymbols
    /**
     * Query Resolvers
     * @protected
     */
    protected gqlExtendedQueryResolvers = {
        getTag: async (parent: any, args: any, ctx: CTX) => {
            const tag = await this.repoFactory(Tag).findByIdThrows(
                new ObjectID(args.id),
                userMessages.tagFailed,
            );
            return await this.orgAuth.asUserWithViewAccess(ctx, tag.orgId, async () =>
                tag.toGQLType(),
            );
        },
    };

    // noinspection JSUnusedGlobalSymbols
    /**
     * Custom Resolvers
     * @protected
     */
    protected gqlCustomResolvers = {
        Tag: {
            revision: async (parent: any, args: any, ctx: CTX) => {
                const revision = await this.repoFactory(Revision).findByIdThrows(
                    new ObjectID(parent.revision_id),
                    userMessages.revisionFailed,
                );
                return await this.orgAuth.asUserWithViewAccess(ctx, revision.orgId, async () =>
                    revision.toGQLType(),
                );
            },
            rule_groups: async (parent: any, args: any, ctx: CTX) => {
                const tag = await this.repoFactory(Tag).findByIdThrows(
                    new ObjectID(parent.id),
                    userMessages.tagFailed,
                );
                return this.orgAuth.asUserWithViewAccess(ctx, tag.orgId, async () =>
                    (await this.repoFactory(RuleGroup).findByIds(tag.ruleGroupIds)).map((_) =>
                        _.toGQLType(),
                    ),
                );
            },
        },
    };
}
